import { mkdtempSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { DomainError } from '../src/domain/errors.js';
import { buildApp } from '../src/app.js';
import { apiErrorDetails } from '../src/http/error-handler.js';
import type { MediaService, PublishSource } from '../src/livekit/media-service.js';
import type { WebhookHandler } from '../src/livekit/webhook-handler.js';
import { SqliteMeetingRepository } from '../src/repositories/sqlite-meeting-repository.js';
import type { IdGenerator, PasswordHasher } from '../src/services/meeting-service.js';
import { MeetingService } from '../src/services/meeting-service.js';
import { HostApplicationService } from '../src/services/host-application-service.js';
import { KeyedMutex } from '../src/services/keyed-mutex.js';
import { ParticipantApplicationService } from '../src/services/participant-application-service.js';
import { startManagedServer } from '../src/server.js';
import { FakeClock } from './fakes/fake-clock.js';

describe('meeting HTTP API', () => {
  let fixture: ApiFixture;

  beforeEach(async () => { fixture = await createFixture(); });
  afterEach(async () => { await fixture.close(); });

  it('creates a meeting with an unpredictable link and a cookie-only host token', async () => {
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/meetings',
      headers: { origin: config.publicBaseUrl.origin },
      payload: { adminPassword: 'admin-secret', name: 'Daily', meetingPassword: 'join-secret' }
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual({
      slug: 'bqG-uP7Yz5mR9vK2xN4dQw',
      joinUrl: 'https://meet.example.test/meetings/bqG-uP7Yz5mR9vK2xN4dQw'
    });
    expect(response.headers['set-cookie']).toContain('wm_host=');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.body).not.toContain('admin-secret');
    expect(response.body).not.toContain('join-secret');
    expect(response.body).not.toContain('raw-host-session');
  });

  it('exposes summary then joins with the exact response fields and cookie-only participant session', async () => {
    const created = await fixture.createMeeting();
    const summary = await fixture.app.inject(`/api/v1/meetings/${created.slug}`);
    const joined = await fixture.app.inject({
      method: 'POST', url: `/api/v1/meetings/${created.slug}/join`,
      headers: { origin: config.publicBaseUrl.origin },
      payload: { nickname: 'Ada', meetingPassword: 'join-secret' }
    });

    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json()).toEqual({
      name: 'Daily', status: 'created', requiresPassword: true, isFull: false
    });
    expect(joined.statusCode).toBe(200);
    expect(Object.keys(joined.json()).sort()).toEqual([
      'livekitUrl', 'meetingExpiresAt', 'participantIdentity',
      'participantName', 'permissions', 'token'
    ]);
    expect(joined.json()).toMatchObject({
      participantName: 'Ada',
      livekitUrl: 'wss://rtc.example.test/',
      permissions: { publishSources: ['microphone'] }
    });
    expect(joined.headers['set-cookie']).toContain('wm_participant=');
    expect(joined.body).not.toContain('raw-participant-session');
    expect(joined.body).not.toContain('join-secret');
  });

  it('refreshes, lists and leaves only through the scoped participant cookie', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');
    fixture.media.identities.set('meeting-id', new Set(['participant-1']));
    const cookie = cookiePair(joined.headers['set-cookie']);

    const refreshed = await fixture.app.inject({
      method: 'POST', url: `/api/v1/meetings/${created.slug}/token`,
      headers: { origin: config.publicBaseUrl.origin, cookie }
    });
    const listed = await fixture.app.inject({
      url: `/api/v1/meetings/${created.slug}/participants`, headers: { cookie }
    });
    const unauthorized = await fixture.app.inject({
      method: 'POST', url: `/api/v1/meetings/${created.slug}/leave`,
      headers: { origin: config.publicBaseUrl.origin }
    });
    const left = await fixture.app.inject({
      method: 'POST', url: `/api/v1/meetings/${created.slug}/leave`,
      headers: { origin: config.publicBaseUrl.origin, cookie }
    });

    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      participantIdentity: 'participant-1',
      permissions: { canPublishMicrophone: true, canShareScreen: false }
    });
    expect(listed.json()).toEqual({
      participants: [{ identity: 'participant-1', name: 'Ada', isSharing: false }]
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(left.statusCode).toBe(204);
  });

  it('authorizes host kick, share grant/revoke and end through the scoped host cookie', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');
    const hostCookie = cookiePair(created.setCookie);
    const participantIdentity = joined.json().participantIdentity as string;

    expect((await fixture.modify('PUT', `${created.slug}/share-grant`, hostCookie, { participantIdentity })).statusCode)
      .toBe(204);
    expect(fixture.media.sourceUpdates.at(-1)?.sources)
      .toEqual(['microphone', 'screen_share', 'screen_share_audio']);
    expect((await fixture.modify('DELETE', `${created.slug}/share-grant`, hostCookie)).statusCode).toBe(204);
    expect((await fixture.modify('POST', `${created.slug}/kick`, hostCookie, { participantIdentity })).statusCode)
      .toBe(204);
    expect((await fixture.modify('POST', `${created.slug}/end`, hostCookie)).statusCode).toBe(204);
    expect((await fixture.modify('POST', `${created.slug}/end`, undefined)).statusCode).toBe(401);
  });

  it('validates TypeBox bodies, strict origins and category rate limits', async () => {
    const missingOrigin = await fixture.app.inject({
      method: 'POST', url: '/api/v1/meetings',
      payload: { adminPassword: 'admin-secret', name: 'Daily' }
    });
    const invalidBody = await fixture.app.inject({
      method: 'POST', url: '/api/v1/meetings', headers: { origin: config.publicBaseUrl.origin },
      payload: { adminPassword: 'admin-secret', name: '', unexpected: true }
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      await fixture.app.inject({
        method: 'POST', url: '/api/v1/meetings', headers: { origin: config.publicBaseUrl.origin },
        payload: { adminPassword: 'wrong', name: 'Daily' }
      });
    }
    const limited = await fixture.app.inject({
      method: 'POST', url: '/api/v1/meetings', headers: { origin: config.publicBaseUrl.origin },
      payload: { adminPassword: 'wrong', name: 'Daily' }
    });

    expect(missingOrigin.statusCode).toBe(403);
    expect(invalidBody.statusCode).toBe(400);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('passes raw webhook bytes and authorization without a public API alias', async () => {
    const body = '{"event":"room_finished","bytes":"✓"}';
    const response = await fixture.app.inject({
      method: 'POST', url: '/internal/livekit/webhook',
      headers: {
        authorization: 'Bearer signed',
        'content-type': 'application/webhook+json'
      },
      payload: body
    });

    expect(response.statusCode).toBe(204);
    expect(new TextDecoder().decode(fixture.webhooks.body)).toBe(body);
    expect(fixture.webhooks.authorization).toBe('Bearer signed');
    expect((await fixture.app.inject('/api/v1/internal/livekit/webhook')).statusCode).toBe(404);
  });

  it('keeps liveness dependency-free and makes readiness depend on SQLite and LiveKit', async () => {
    const live = await fixture.app.inject('/health/live');
    const ready = await fixture.app.inject('/health/ready');
    fixture.media.pingError = new Error('unavailable');
    const unavailable = await fixture.app.inject('/health/ready');

    expect(live).toMatchObject({ statusCode: 200 });
    expect(live.json()).toEqual({ status: 'ok' });
    expect(ready).toMatchObject({ statusCode: 200 });
    expect(ready.json()).toEqual({ status: 'ready' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: { code: 'MEDIA_SERVICE_UNAVAILABLE' } });
  });
});

describe('API error mapping', () => {
  it.each([
    ['MEETING_NOT_FOUND', 404], ['MEETING_EXPIRED', 410], ['MEETING_FULL', 409],
    ['INVALID_MEETING_PASSWORD', 401], ['ADMIN_AUTH_FAILED', 401],
    ['SHARE_ALREADY_ACTIVE', 409], ['SHARE_NOT_AUTHORIZED', 403],
    ['UNSUPPORTED_CLIENT', 400], ['RATE_LIMITED', 429], ['MEDIA_SERVICE_UNAVAILABLE', 503]
  ] as const)('maps %s to %i with the common envelope', (code, statusCode) => {
    expect(apiErrorDetails(new DomainError(code), 'correlation-1')).toEqual({
      statusCode,
      body: { error: { code, message: expect.any(String), correlationId: 'correlation-1' } }
    });
  });

  it('logs unknown failures by correlation ID without exposing internals', async () => {
    const fixture = await createFixture({ meetingSummaryError: new Error(
      'SELECT secret FROM host_sessions at ws://livekit.internal stack trace'
    ) });
    const log = vi.spyOn(fixture.app.log, 'error');

    const response = await fixture.app.inject('/api/v1/meetings/abcdefghijklmnopqrstuv');

    expect(response.statusCode, response.body).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'MEDIA_SERVICE_UNAVAILABLE',
        message: expect.any(String),
        correlationId: expect.any(String)
      }
    });
    expect(response.body).not.toMatch(/SELECT|secret|livekit\.internal|stack/i);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: response.json().error.correlationId }),
      'Unhandled API error'
    );
    await fixture.close();
  });
});

describe('server lifecycle', () => {
  it('runs immediate cleanup, prevents interval overlap and closes on SIGTERM', async () => {
    vi.useFakeTimers();
    const signals = new EventEmitter();
    const secondCleanup = deferred<void>();
    let cleanups = 0;
    const meetings = {
      runCleanup: vi.fn(async () => {
        cleanups++;
        if (cleanups === 2) await secondCleanup.promise;
        return [];
      })
    };
    const app = {
      listen: vi.fn(async () => 'http://127.0.0.1:3000'),
      close: vi.fn(async () => undefined),
      log: { error: vi.fn() }
    };
    const database = { close: vi.fn() };

    const managed = await startManagedServer({ app, database, meetings, signals, intervalMs: 30_000 });
    expect(meetings.runCleanup).toHaveBeenCalledTimes(1);
    expect(app.listen).toHaveBeenCalledWith({ host: '0.0.0.0', port: 3000 });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(meetings.runCleanup).toHaveBeenCalledTimes(2);
    signals.emit('SIGTERM');
    await Promise.resolve();
    expect(app.close).not.toHaveBeenCalled();
    expect(database.close).not.toHaveBeenCalled();
    secondCleanup.resolve();
    await vi.waitFor(() => expect(app.close).toHaveBeenCalledOnce());
    expect(database.close).toHaveBeenCalledOnce();
    await managed.shutdown();
    vi.useRealTimers();
  });
});

interface ApiFixture {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: Database.Database;
  directory: string;
  media: ApiMediaFake;
  webhooks: CapturingWebhookHandler;
  createMeeting(): Promise<{ slug: string; setCookie: string | string[] | undefined }>;
  join(slug: string, nickname: string): ReturnType<ApiFixture['app']['inject']>;
  modify(method: 'POST' | 'PUT' | 'DELETE', suffix: string, cookie?: string, payload?: object): ReturnType<ApiFixture['app']['inject']>;
  close(): Promise<void>;
}

async function createFixture(options: { meetingSummaryError?: Error } = {}): Promise<ApiFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'meeting-api-'));
  const db = createDatabase(join(directory, 'meetings.sqlite'));
  migrate(db);
  const repository = new SqliteMeetingRepository(db);
  const clock = new FakeClock(1_000);
  const ids = new ApiIds();
  const media = new ApiMediaFake();
  const mutex = new KeyedMutex();
  const passwords = new LiteralPasswordHasher();
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
  if (options.meetingSummaryError) {
    meetings.getMeetingSummary = async () => { throw options.meetingSummaryError; };
  }
  const hosts = new HostApplicationService({
    repository, meetings, media, passwords, clock, ids, config, mutex
  });
  const participants = new ParticipantApplicationService({ repository, media, clock, config });
  const webhooks = new CapturingWebhookHandler();
  const app = await buildApp({ config, meetings, hosts, participants, media, webhooks });

  const fixture: ApiFixture = {
    app, db, directory, media, webhooks,
    async createMeeting() {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/meetings', headers: { origin: config.publicBaseUrl.origin },
        payload: { adminPassword: 'admin-secret', name: 'Daily', meetingPassword: 'join-secret' }
      });
      return { slug: response.json().slug as string, setCookie: response.headers['set-cookie'] };
    },
    join(slug, nickname) {
      return app.inject({
        method: 'POST', url: `/api/v1/meetings/${slug}/join`,
        headers: { origin: config.publicBaseUrl.origin },
        payload: { nickname, meetingPassword: 'join-secret' }
      });
    },
    modify(method, suffix, cookie, payload) {
      return app.inject({
        method, url: `/api/v1/meetings/${suffix}`,
        headers: { origin: config.publicBaseUrl.origin, ...(cookie ? { cookie } : {}) }, payload
      });
    },
    async close() {
      await app.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
  return fixture;
}

const config: AppConfig = {
  nodeEnv: 'test', publicBaseUrl: new URL('https://meet.example.test'),
  livekitUrl: new URL('wss://rtc.example.test'), livekitInternalUrl: new URL('ws://livekit.internal'),
  livekitApiKey: 'key', livekitApiSecret: 'secret', adminPasswordHash: 'hash:admin-secret',
  cookieSecret: 'a'.repeat(32), databasePath: ':memory:', meetingTtlMs: 86_400_000,
  emptyGraceMs: 600_000, reconnectGraceMs: 30_000, reservationTtlMs: 60_000, maxParticipants: 5
};

class LiteralPasswordHasher implements PasswordHasher {
  async hash(value: string): Promise<string> { return `hash:${value}`; }
  async verify(hash: string, value: string): Promise<boolean> { return hash === `hash:${value}`; }
}

class ApiIds implements IdGenerator {
  private participant = 0;
  private tokenCount = 0;
  private uuidCount = 0;
  uuid(): string { return this.uuidCount++ === 0 ? 'meeting-id' : `host-${this.uuidCount}`; }
  slug(): string { return 'bqG-uP7Yz5mR9vK2xN4dQw'; }
  token(): string { return this.tokenCount++ === 0 ? 'raw-host-session' : `raw-participant-session-${this.tokenCount}`; }
  participantIdentity(): string { return `participant-${++this.participant}`; }
}

class ApiMediaFake implements MediaService {
  readonly identities = new Map<string, Set<string>>();
  readonly sourceUpdates: Array<{ identity: string; sources: PublishSource[] }> = [];
  pingError?: Error;
  async listParticipantIdentities(roomName: string): Promise<Set<string>> { return new Set(this.identities.get(roomName) ?? []); }
  async issueToken(input: { identity: string }): Promise<string> { return `livekit-token:${input.identity}`; }
  async updateParticipantSources(_roomName: string, identity: string, sources: PublishSource[]): Promise<void> {
    this.sourceUpdates.push({ identity, sources: [...sources] });
  }
  async removeParticipant(roomName: string, identity: string): Promise<void> { this.identities.get(roomName)?.delete(identity); }
  async deleteRoom(roomName: string): Promise<void> { this.identities.delete(roomName); }
  async ping(): Promise<void> { if (this.pingError) throw this.pingError; }
}

class CapturingWebhookHandler implements WebhookHandler {
  body = new Uint8Array();
  authorization?: string;
  async handle(rawBody: Uint8Array, authorization?: string): Promise<void> {
    this.body = rawBody;
    this.authorization = authorization;
  }
}

function cookiePair(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) throw new Error('Expected Set-Cookie header');
  return value.split(';', 1)[0];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}
