import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('anonymous P2P quality stats endpoint', () => {
  let fixture: StatsFixture;

  beforeEach(async () => { fixture = await createFixture(); });
  afterEach(async () => { await fixture.close(); });

  const validReport = {
    sessionId: 'anon-session-1',
    attempts: 3,
    p2pSucceeded: 2,
    fallbacks: 1,
    avgSetupMs: 412.5,
    avgRttMs: 88,
    maxLossPct: 4.2
  };

  it('rejects an unauthenticated report with the existing 401 behavior and writes no audit event', async () => {
    const created = await fixture.createMeeting();
    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/meetings/${created.slug}/p2p-stats`,
      headers: { origin: config.publicBaseUrl.origin },
      payload: validReport
    });

    expect(response.statusCode, response.body).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'ADMIN_AUTH_FAILED' } });
    expect(fixture.auditEvents()).toEqual([]);
  });

  it('rejects a payload that fails schema validation with 400 and writes no audit event', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');

    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/meetings/${created.slug}/p2p-stats`,
      headers: { cookie: cookiePair(joined.headers['set-cookie']), origin: config.publicBaseUrl.origin },
      payload: { ...validReport, attempts: -1 }
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_CLIENT' } });
    expect(fixture.auditEvents()).toEqual([]);
  });

  it('records exactly one anonymous audit event for a valid report', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');

    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/meetings/${created.slug}/p2p-stats`,
      headers: { cookie: cookiePair(joined.headers['set-cookie']), origin: config.publicBaseUrl.origin },
      payload: validReport
    });

    expect(response.statusCode, response.body).toBe(204);
    const events = fixture.auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'p2p_stats_report',
      meeting_id: null,
      subject_id: null
    });
    // The audit event carries only the anonymous payload: the meeting id is
    // hashed server-side, and no identity, slug, SDP, media or IP fields exist.
    expect(JSON.parse(events[0].metadata_json)).toEqual({
      meetingIdHash: createHash('sha256').update('meeting-id').digest('hex').slice(0, 16),
      ...validReport
    });
  });

  it('does not authenticate another room using a valid room-scoped participant cookie', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/meetings/abcdefghijklmnopqrstuv/p2p-stats',
      headers: { cookie: cookiePair(joined.headers['set-cookie']), origin: config.publicBaseUrl.origin },
      payload: validReport
    });

    expect(response.statusCode, response.body).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'ADMIN_AUTH_FAILED' } });
  });

  it('accepts a report after the meeting has ended while the join cookie is still signed', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');
    const ended = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/meetings/${created.slug}/end`,
      headers: { cookie: cookiePair(created.hostCookie), origin: config.publicBaseUrl.origin }
    });
    expect(ended.statusCode).toBe(204);

    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/v1/meetings/${created.slug}/p2p-stats`,
      headers: { cookie: cookiePair(joined.headers['set-cookie']), origin: config.publicBaseUrl.origin },
      payload: validReport
    });

    expect(response.statusCode, response.body).toBe(204);
    const statsEvents = fixture.auditEvents().filter((event) => event.event_type === 'p2p_stats_report');
    expect(statsEvents).toHaveLength(1);
  });
});

describe('screen-share quality uploads', () => {
  let fixture: StatsFixture;
  const payload = {
    version: 1, traceId: 'a'.repeat(32), sourceKey: 'b'.repeat(32), role: 'viewer',
    sequence: 0, final: false, samples: [{ at: 1, mode: 'p2p', links: [
      { link: 1, transport: 'p2p', rtc: { receivedFps: 53, decodedFps: 52, freezes: 1 } }
    ] }]
  };

  beforeEach(async () => { fixture = await createFixture(); });
  afterEach(async () => { vi.restoreAllMocks(); await fixture.close(); });

  it('authenticates and writes an allowlisted log to the existing log sink', async () => {
    const log = vi.spyOn(fixture.app.log, 'info');
    const { slug } = await fixture.createMeeting();
    const url = `/api/v1/meetings/${slug}/screen-share-quality`;
    const origin = config.publicBaseUrl.origin;
    const joined = await fixture.join(slug, 'Ada');
    const cookie = cookiePair(joined.headers['set-cookie']);
    const unauthorized = await fixture.app.inject({ method: 'POST', url, headers: { origin }, payload });
    expect(unauthorized.statusCode).toBe(401);
    const invalid = await fixture.app.inject({ method: 'POST', url, headers: { origin, cookie },
      payload: { ...payload, samples: [{ ...payload.samples[0], candidateUrl: 'turn:example.org' }] }
    });
    expect(invalid.statusCode).toBe(400);
    const accepted = await fixture.app.inject({ method: 'POST', url, headers: { origin, cookie }, payload });
    expect(accepted.statusCode, accepted.body).toBe(204);
    const rows = log.mock.calls.filter(([row]) => typeof row === 'object' && row !== null
      && 'event' in row && row.event === 'screen_share_quality');
    expect(rows).toEqual([[{
      event: 'screen_share_quality', meetingKey: expect.stringMatching(/^[a-f0-9]{32}$/), ...payload
    }, 'Screen share quality']]);
    expect(JSON.stringify(rows)).not.toContain(slug);
  });

  it('rejects a final batch once its participant session is revoked', async () => {
    const { slug } = await fixture.createMeeting();
    const joined = await fixture.join(slug, 'Ada');
    const headers = { cookie: cookiePair(joined.headers['set-cookie']), origin: config.publicBaseUrl.origin };
    const leave = await fixture.app.inject({ method: 'POST', url: `/api/v1/meetings/${slug}/leave`, headers });
    expect(leave.statusCode).toBe(204);
    const final = await fixture.app.inject({ method: 'POST', url: `/api/v1/meetings/${slug}/screen-share-quality`,
      headers, payload: { ...payload, final: true } });
    expect(final.statusCode).toBe(401);
  });
});

interface StatsFixture {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: Database.Database;
  directory: string;
  auditEvents(): Array<{
    event_type: string;
    meeting_id: string | null;
    subject_id: string | null;
    metadata_json: string;
  }>;
  createMeeting(): Promise<{ slug: string; hostCookie: string }>;
  join(slug: string, nickname: string): ReturnType<Awaited<ReturnType<typeof buildApp>>['inject']>;
  close(): Promise<void>;
}

async function createFixture(): Promise<StatsFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'meeting-p2p-stats-'));
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
    app, db, directory,
    auditEvents() {
      return db.prepare('SELECT event_type, meeting_id, subject_id, metadata_json FROM audit_events ORDER BY occurred_at, id')
        .all() as Array<{
          event_type: string;
          meeting_id: string | null;
          subject_id: string | null;
          metadata_json: string;
        }>;
    },
    async createMeeting() {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/meetings', headers: { origin: config.publicBaseUrl.origin },
        payload: { adminPassword: 'admin-secret', name: 'Daily', meetingPassword: 'join-secret' }
      });
      return {
        slug: response.json().slug as string,
        hostCookie: cookiePair(response.headers['set-cookie'])
      };
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
  p2pStunUrls: ['stun:stun.example.test:3478']
};

class RouteMediaFake implements MediaService {
  async listParticipantIdentities(): Promise<Set<string>> { return new Set(); }
  async issueToken(input: IssueTokenInput): Promise<string> { return `livekit-token:${input.identity}`; }
  async updateParticipantSources(): Promise<void> {}
  async removeParticipant(): Promise<void> {}
  async deleteRoom(): Promise<void> {}
  async ping(): Promise<void> {}
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
