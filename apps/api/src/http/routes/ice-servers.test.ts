import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import type { AppConfig } from '../../config.js';
import { createDatabase } from '../../db/database.js';
import { migrate } from '../../db/migrate.js';
import type {
  IssueTokenInput,
  MediaService
} from '../../livekit/media-service.js';
import type { WebhookHandler } from '../../livekit/webhook-handler.js';
import { SqliteMeetingRepository } from '../../repositories/sqlite-meeting-repository.js';
import { KeyedMutex } from '../../services/keyed-mutex.js';
import { HostApplicationService } from '../../services/host-application-service.js';
import type { IdGenerator, PasswordHasher } from '../../services/meeting-service.js';
import { MeetingService } from '../../services/meeting-service.js';
import { ParticipantApplicationService } from '../../services/participant-application-service.js';
import { FakeClock } from '../../../test/fakes/fake-clock.js';

describe('ICE credentials endpoint', () => {
  let fixture: IceFixture;

  beforeEach(async () => { fixture = await createFixture(); });
  afterEach(async () => { await fixture.close(); });

  it('rejects an unauthenticated request with the existing 401 behavior', async () => {
    const created = await fixture.createMeeting();
    const response = await fixture.app.inject({
      url: `/api/v1/meetings/${created.slug}/ice-servers`
    });

    expect(response.statusCode, response.body).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'ADMIN_AUTH_FAILED' } });
    expect(fixture.media.fetchCalls).toBe(0);
  });

  it('returns STUN and participant-bound short-lived TURN credentials without calling LiveKit', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');
    fixture.media.iceServers = [
      { urls: ['turn:must-not-be-used.example.test:3478'] }
    ];

    const response = await fixture.app.inject({
      url: `/api/v1/meetings/${created.slug}/ice-servers`,
      headers: { cookie: cookiePair(joined.headers['set-cookie']) }
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { iceServers: Array<{
      urls: string[]; username?: string; credential?: string;
    }> };
    expect(body.iceServers[0]).toEqual({ urls: ['stun:stun1.example.test:3478'] });
    expect(body.iceServers[1]).toMatchObject({
      urls: ['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:5349?transport=tcp']
    });
    const participantIdentity = (joined.json() as { participantIdentity: string }).participantIdentity;
    expect(body.iceServers[1].username).toMatch(new RegExp(`^\\d+:${participantIdentity}$`));
    expect(body.iceServers[1].credential).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const expiry = Number(body.iceServers[1].username?.split(':', 1)[0]);
    expect(expiry).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1_000) + 599);
    expect(expiry).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000) + 601);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(fixture.media.fetchCalls).toBe(0);
  });

  it('returns 404 for an unknown meeting even with a valid participant cookie', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');

    const response = await fixture.app.inject({
      url: '/api/v1/meetings/abcdefghijklmnopqrstuv/ice-servers',
      headers: { cookie: cookiePair(joined.headers['set-cookie']) }
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'MEETING_NOT_FOUND' } });
  });

  it('does not depend on LiveKit availability', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');
    fixture.media.iceServersError = new Error('LiveKit unreachable');

    const response = await fixture.app.inject({
      url: `/api/v1/meetings/${created.slug}/ice-servers`,
      headers: { cookie: cookiePair(joined.headers['set-cookie']) }
    });

    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as { iceServers: unknown[] }).iceServers).toHaveLength(2);
    expect(fixture.media.fetchCalls).toBe(0);
  });
});

interface IceFixture {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: Database.Database;
  directory: string;
  media: RouteMediaFake;
  createMeeting(): Promise<{ slug: string }>;
  join(slug: string, nickname: string): ReturnType<Awaited<ReturnType<typeof buildApp>>['inject']>;
  close(): Promise<void>;
}

async function createFixture(): Promise<IceFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'meeting-ice-'));
  const db = createDatabase(join(directory, 'meetings.sqlite'));
  migrate(db);
  const repository = new SqliteMeetingRepository(db);
  const clock = new FakeClock(1_000);
  const ids = new RouteIds();
  const media = new RouteMediaFake();
  const passwords = new LiteralPasswordHasher();
  const mutex = new KeyedMutex();
  const meetings = new MeetingService({
    repository,
    media: {
      listParticipantIdentities: async (meetingId) => [...await media.listParticipantIdentities(meetingId)],
      issueParticipantToken: (input) => media.issueToken(input),
      removeParticipant: (meetingId, identity) => media.removeParticipant(meetingId, identity),
      closeMeeting: (meetingId) => media.deleteRoom(meetingId)
    },
    passwords, clock, ids, config, mutex
  });
  const hosts = new HostApplicationService({ repository, meetings, media, passwords, clock, ids, config, mutex });
  const participants = new ParticipantApplicationService({ repository, media, clock, ids, config });
  const app = await buildApp({
    config, meetings, hosts, participants, media, webhooks: new StubWebhookHandler()
  });

  return {
    app, db, directory, media,
    async createMeeting() {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/meetings', headers: { origin: config.publicBaseUrl.origin },
        payload: { adminPassword: 'admin-secret', name: 'Daily', meetingPassword: 'join-secret' }
      });
      return { slug: response.json().slug as string };
    },
    join(slug, nickname) {
      return app.inject({
        method: 'POST', url: `/api/v1/meetings/${slug}/join`,
        headers: { origin: config.publicBaseUrl.origin },
        payload: { nickname, meetingPassword: 'join-secret' }
      });
    },
    async close() {
      await app.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

const config: AppConfig = {
  nodeEnv: 'test', publicBaseUrl: new URL('https://meet.example.test'),
  livekitUrl: new URL('wss://rtc.example.test'), livekitInternalUrl: new URL('ws://livekit.internal'),
  livekitApiKey: 'key', livekitApiSecret: 'secret', adminPasswordHash: 'hash:admin-secret',
  cookieSecret: 'a'.repeat(32), databasePath: ':memory:', meetingTtlMs: 86_400_000,
  emptyGraceMs: 600_000, reconnectGraceMs: 30_000, reservationTtlMs: 60_000, maxParticipants: 5,
  p2pStunUrls: ['stun:stun1.example.test:3478'],
  p2pTurnUrls: ['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:5349?transport=tcp'],
  p2pTurnSecret: '0123456789abcdef0123456789abcdef', p2pTurnTtlSeconds: 600
};

class RouteMediaFake implements MediaService {
  iceServers: Array<{ urls: string[] }> = [];
  iceServersError?: Error;
  fetchCalls = 0;

  async listParticipantIdentities(): Promise<Set<string>> { return new Set(); }
  async issueToken(input: IssueTokenInput): Promise<string> { return `livekit-token:${input.identity}`; }
  async updateParticipantSources(): Promise<void> {}
  async removeParticipant(): Promise<void> {}
  async deleteRoom(): Promise<void> {}
  async ping(): Promise<void> {}
  async fetchIceServers(): Promise<Array<{ urls: string[] }>> {
    this.fetchCalls++;
    if (this.iceServersError) throw this.iceServersError;
    return this.iceServers;
  }
}

class StubWebhookHandler implements WebhookHandler {
  async handle(): Promise<void> {}
}

class LiteralPasswordHasher implements PasswordHasher {
  async hash(value: string): Promise<string> { return `hash:${value}`; }
  async verify(hash: string, value: string): Promise<boolean> { return hash === `hash:${value}`; }
}

class RouteIds implements IdGenerator {
  private participant = 0;
  private tokenCount = 0;
  private uuidCount = 0;
  uuid(): string { return this.uuidCount++ === 0 ? 'meeting-id' : `host-${this.uuidCount}`; }
  slug(): string { return 'bqG-uP7Yz5mR9vK2xN4dQw'; }
  token(): string { return this.tokenCount++ === 0 ? 'raw-host-session' : `raw-participant-session-${this.tokenCount}`; }
  participantIdentity(): string { return `participant-${++this.participant}`; }
}

function cookiePair(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) throw new Error('Expected Set-Cookie header');
  return value.split(';', 1)[0];
}
