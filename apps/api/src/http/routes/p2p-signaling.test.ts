import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { P2P_MESSAGE_MAX_BYTES } from '@meeting/contracts';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../../app.js';
import type { AppConfig } from '../../config.js';
import { createDatabase } from '../../db/database.js';
import { migrate } from '../../db/migrate.js';
import type {
  IssueTokenInput,
  MediaService
} from '../../livekit/media-service.js';
import type { WebhookHandler } from '../../livekit/webhook-handler.js';
import { P2P_CLOSE_POLICY_VIOLATION } from '../../p2p/signaling-session.js';
import { SqliteMeetingRepository } from '../../repositories/sqlite-meeting-repository.js';
import { KeyedMutex } from '../../services/keyed-mutex.js';
import { HostApplicationService } from '../../services/host-application-service.js';
import type { IdGenerator, PasswordHasher } from '../../services/meeting-service.js';
import { MeetingService } from '../../services/meeting-service.js';
import { ParticipantApplicationService } from '../../services/participant-application-service.js';
import { FakeClock } from '../../../test/fakes/fake-clock.js';

describe('P2P signaling websocket endpoint', () => {
  let fixture: P2pFixture;

  beforeEach(async () => { fixture = await createFixture(); });
  afterEach(async () => { await fixture.close(); });

  it('rejects the handshake with 401 without a participant cookie', async () => {
    const created = await fixture.createMeeting();
    await expect(
      fixture.app.injectWS(`/api/v1/meetings/${created.slug}/p2p`)
    ).rejects.toThrow('Unexpected server response: 401');
  });

  it('rejects the handshake with 404 for an unknown meeting', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');
    await expect(
      fixture.app.injectWS('/api/v1/meetings/abcdefghijklmnopqrstuv/p2p', { headers: { cookie: joined.cookie } })
    ).rejects.toThrow('Unexpected server response: 404');
  });

  it('rejects the handshake with 401 after the meeting ended', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');
    await fixture.endMeeting(created.slug, created.hostCookie);

    // Ending the meeting revokes participant sessions, so the stale cookie
    // fails session authentication with the same 401 as the other endpoints.
    await expect(
      fixture.app.injectWS(`/api/v1/meetings/${created.slug}/p2p`, { headers: { cookie: joined.cookie } })
    ).rejects.toThrow('Unexpected server response: 401');
  });

  it('welcomes a connected participant and answers pings', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');
    const ws = await fixture.connect(created.slug, joined.cookie);
    const inbox = collect(ws);

    expect(await inbox.waitFor((message) => message.type === 'welcome'))
      .toEqual({ type: 'welcome', peers: [] });

    ws.send(JSON.stringify({ type: 'hello', participantIdentity: joined.identity }));
    ws.send(JSON.stringify({ type: 'ping' }));
    expect(await inbox.waitFor((message) => message.type === 'pong')).toEqual({ type: 'pong' });
    ws.close();
  });

  it('disconnects when hello identity does not match the session', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');
    const ws = await fixture.connect(created.slug, joined.cookie);
    const inbox = collect(ws);
    await inbox.waitFor((message) => message.type === 'welcome');

    ws.send(JSON.stringify({ type: 'hello', participantIdentity: 'someone-else' }));

    expect((await inbox.closed()).code).toBe(P2P_CLOSE_POLICY_VIOLATION);
    expect(inbox.messages.at(-1)).toMatchObject({ type: 'error', code: 'P2P_FORBIDDEN' });
  });

  it('broadcasts peer-joined and peer-left between members', async () => {
    const created = await fixture.createMeeting();
    const ada = await fixture.join(created.slug, 'Ada');
    const bob = await fixture.join(created.slug, 'Bob');
    const wsA = await fixture.connect(created.slug, ada.cookie);
    const inboxA = collect(wsA);
    await inboxA.waitFor((message) => message.type === 'welcome');

    const wsB = await fixture.connect(created.slug, bob.cookie);
    const inboxB = collect(wsB);

    expect(await inboxA.waitFor((message) => message.type === 'peer-joined'))
      .toEqual({ type: 'peer-joined', peer: { identity: bob.identity, nickname: 'Bob' } });
    expect(await inboxB.waitFor((message) => message.type === 'welcome'))
      .toEqual({ type: 'welcome', peers: [{ identity: ada.identity, nickname: 'Ada' }] });

    wsB.close();
    expect(await inboxA.waitFor((message) => message.type === 'peer-left'))
      .toEqual({ type: 'peer-left', peer: { identity: bob.identity } });
    wsA.close();
  });

  it('forwards signaling between the sharer and a viewer, and blocks non-sharers', async () => {
    const created = await fixture.createMeeting();
    const ada = await fixture.join(created.slug, 'Ada');
    const bob = await fixture.join(created.slug, 'Bob');
    await fixture.grantShare(created.slug, created.hostCookie, ada.identity);
    const wsA = await fixture.connect(created.slug, ada.cookie);
    const inboxA = collect(wsA);
    const wsB = await fixture.connect(created.slug, bob.cookie);
    const inboxB = collect(wsB);
    await inboxB.waitFor((message) => message.type === 'welcome');

    wsA.send(JSON.stringify({ type: 'offer', to: bob.identity, sdp: 'sdp-a' }));
    expect(await inboxB.waitFor((message) => message.type === 'offer'))
      .toEqual({ type: 'offer', to: bob.identity, sdp: 'sdp-a', from: ada.identity });

    wsB.send(JSON.stringify({ type: 'answer', to: ada.identity, sdp: 'sdp-b' }));
    expect(await inboxA.waitFor((message) => message.type === 'answer'))
      .toEqual({ type: 'answer', to: ada.identity, sdp: 'sdp-b', from: bob.identity });

    wsB.send(JSON.stringify({ type: 'ice', to: ada.identity, candidate: 'candidate:1' }));
    expect(await inboxA.waitFor((message) => message.type === 'ice'))
      .toEqual({ type: 'ice', to: ada.identity, candidate: 'candidate:1', from: bob.identity });
    wsA.close();
    wsB.close();
  });

  it('rejects an offer from a non-sharer with P2P_FORBIDDEN and does not forward it', async () => {
    const created = await fixture.createMeeting();
    const ada = await fixture.join(created.slug, 'Ada');
    const bob = await fixture.join(created.slug, 'Bob');
    const wsA = await fixture.connect(created.slug, ada.cookie);
    const inboxA = collect(wsA);
    const wsB = await fixture.connect(created.slug, bob.cookie);
    const inboxB = collect(wsB);
    await inboxA.waitFor((message) => message.type === 'welcome');

    wsA.send(JSON.stringify({ type: 'offer', to: bob.identity, sdp: 'sdp-a' }));

    expect(await inboxA.waitFor((message) => message.type === 'error'))
      .toMatchObject({ type: 'error', code: 'P2P_FORBIDDEN' });
    expect(inboxB.messages.filter((message) => message.type === 'offer')).toEqual([]);
    wsA.close();
    wsB.close();
  });

  it('reports P2P_PEER_NOT_FOUND when the target is not online', async () => {
    const created = await fixture.createMeeting();
    const ada = await fixture.join(created.slug, 'Ada');
    await fixture.grantShare(created.slug, created.hostCookie, ada.identity);
    const wsA = await fixture.connect(created.slug, ada.cookie);
    const inboxA = collect(wsA);
    await inboxA.waitFor((message) => message.type === 'welcome');

    wsA.send(JSON.stringify({ type: 'offer', to: 'ghost-peer', sdp: 'sdp-x' }));

    expect(await inboxA.waitFor((message) => message.type === 'error'))
      .toMatchObject({ type: 'error', code: 'P2P_PEER_NOT_FOUND' });
    wsA.close();
  });

  it('rejects a message over the 64 KiB contract limit at the socket level', async () => {
    const created = await fixture.createMeeting();
    const joined = await fixture.join(created.slug, 'Ada');
    const ws = await fixture.connect(created.slug, joined.cookie);
    const inbox = collect(ws);
    await inbox.waitFor((message) => message.type === 'welcome');

    ws.send(JSON.stringify({ type: 'offer', to: 'x', sdp: 'y'.repeat(P2P_MESSAGE_MAX_BYTES) }));

    // The ws server maxPayload kills oversized frames before app processing (1009).
    expect((await inbox.closed()).code).toBe(1009);
  });

  it('broadcasts share-gone to all peers when the host revokes the share', async () => {
    const created = await fixture.createMeeting();
    const ada = await fixture.join(created.slug, 'Ada');
    const bob = await fixture.join(created.slug, 'Bob');
    await fixture.grantShare(created.slug, created.hostCookie, ada.identity);
    const wsA = await fixture.connect(created.slug, ada.cookie);
    const inboxA = collect(wsA);
    const wsB = await fixture.connect(created.slug, bob.cookie);
    const inboxB = collect(wsB);
    await inboxA.waitFor((message) => message.type === 'welcome');

    await fixture.app.inject({
      method: 'DELETE', url: `/api/v1/meetings/${created.slug}/share-grant`,
      headers: { origin: config.publicBaseUrl.origin, cookie: created.hostCookie }
    });

    expect(await inboxA.waitFor((message) => message.type === 'share-gone'))
      .toEqual({ type: 'share-gone', reason: 'share released' });
    expect(await inboxB.waitFor((message) => message.type === 'share-gone'))
      .toEqual({ type: 'share-gone', reason: 'share released' });
    wsA.close();
    wsB.close();
  });

  it('broadcasts share-gone when the sharer releases the share itself', async () => {
    const created = await fixture.createMeeting();
    const ada = await fixture.join(created.slug, 'Ada');
    const bob = await fixture.join(created.slug, 'Bob');
    await fixture.grantShare(created.slug, created.hostCookie, ada.identity);
    const wsA = await fixture.connect(created.slug, ada.cookie);
    const inboxA = collect(wsA);
    const wsB = await fixture.connect(created.slug, bob.cookie);
    const inboxB = collect(wsB);
    await inboxA.waitFor((message) => message.type === 'welcome');

    await fixture.app.inject({
      method: 'DELETE', url: `/api/v1/meetings/${created.slug}/share`,
      headers: { origin: config.publicBaseUrl.origin, cookie: ada.cookie }
    });

    expect(await inboxA.waitFor((message) => message.type === 'share-gone'))
      .toEqual({ type: 'share-gone', reason: 'share released' });
    expect(await inboxB.waitFor((message) => message.type === 'share-gone'))
      .toEqual({ type: 'share-gone', reason: 'share released' });
    wsA.close();
    wsB.close();
  });

  it('does not broadcast share-gone when a non-sharer calls DELETE /share', async () => {
    const created = await fixture.createMeeting();
    const ada = await fixture.join(created.slug, 'Ada');
    const bob = await fixture.join(created.slug, 'Bob');
    await fixture.grantShare(created.slug, created.hostCookie, ada.identity);
    const wsA = await fixture.connect(created.slug, ada.cookie);
    const inboxA = collect(wsA);
    const wsB = await fixture.connect(created.slug, bob.cookie);
    const inboxB = collect(wsB);
    await inboxA.waitFor((message) => message.type === 'welcome');

    const response = await fixture.app.inject({
      method: 'DELETE', url: `/api/v1/meetings/${created.slug}/share`,
      headers: { origin: config.publicBaseUrl.origin, cookie: bob.cookie }
    });
    expect(response.statusCode, response.body).toBe(204);

    // releaseParticipantShare no-ops for a viewer: no share-gone is announced
    // and the sharer still holds the lock (offers keep flowing).
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(inboxA.messages.filter((message) => message.type === 'share-gone')).toEqual([]);
    expect(inboxB.messages.filter((message) => message.type === 'share-gone')).toEqual([]);

    wsA.send(JSON.stringify({ type: 'offer', to: bob.identity, sdp: 'sdp-after' }));
    expect(await inboxB.waitFor((message) => message.type === 'offer'))
      .toEqual({ type: 'offer', to: bob.identity, sdp: 'sdp-after', from: ada.identity });
    wsA.close();
    wsB.close();
  });

  it('does not broadcast share-gone when the host revokes without an active share', async () => {
    const created = await fixture.createMeeting();
    const ada = await fixture.join(created.slug, 'Ada');
    const wsA = await fixture.connect(created.slug, ada.cookie);
    const inboxA = collect(wsA);
    await inboxA.waitFor((message) => message.type === 'welcome');

    const response = await fixture.app.inject({
      method: 'DELETE', url: `/api/v1/meetings/${created.slug}/share-grant`,
      headers: { origin: config.publicBaseUrl.origin, cookie: created.hostCookie }
    });
    expect(response.statusCode, response.body).toBe(204);

    // revokeShare no-ops without a holder: no share-gone is announced.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(inboxA.messages.filter((message) => message.type === 'share-gone')).toEqual([]);
    wsA.close();
  });

  it('broadcasts share-gone when the host ends the meeting', async () => {
    const created = await fixture.createMeeting();
    const ada = await fixture.join(created.slug, 'Ada');
    await fixture.grantShare(created.slug, created.hostCookie, ada.identity);
    const wsA = await fixture.connect(created.slug, ada.cookie);
    const inboxA = collect(wsA);
    await inboxA.waitFor((message) => message.type === 'welcome');

    await fixture.endMeeting(created.slug, created.hostCookie);

    expect(await inboxA.waitFor((message) => message.type === 'share-gone'))
      .toEqual({ type: 'share-gone', reason: 'meeting ended' });
    wsA.close();
  });
});

interface P2pFixture {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: Database.Database;
  directory: string;
  media: RouteMediaFake;
  createMeeting(): Promise<{ slug: string; hostCookie: string }>;
  join(slug: string, nickname: string): Promise<{ cookie: string; identity: string }>;
  grantShare(slug: string, hostCookie: string, identity: string): Promise<void>;
  endMeeting(slug: string, hostCookie: string): Promise<void>;
  connect(slug: string, cookie: string): Promise<WebSocket>;
  close(): Promise<void>;
}

async function createFixture(): Promise<P2pFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'meeting-p2p-'));
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
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;

  return {
    app, db, directory, media,
    async createMeeting() {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/meetings', headers: { origin: config.publicBaseUrl.origin },
        payload: { adminPassword: 'admin-secret', name: 'Daily', meetingPassword: 'join-secret' }
      });
      return { slug: response.json().slug as string, hostCookie: cookiePair(response.headers['set-cookie']) };
    },
    async join(slug, nickname) {
      const response = await app.inject({
        method: 'POST', url: `/api/v1/meetings/${slug}/join`,
        headers: { origin: config.publicBaseUrl.origin },
        payload: { nickname, meetingPassword: 'join-secret' }
      });
      return {
        cookie: cookiePair(response.headers['set-cookie']),
        identity: response.json().participantIdentity as string
      };
    },
    async grantShare(slug, hostCookie, identity) {
      const response = await app.inject({
        method: 'PUT', url: `/api/v1/meetings/${slug}/share-grant`,
        headers: { origin: config.publicBaseUrl.origin, cookie: hostCookie },
        payload: { participantIdentity: identity }
      });
      expect(response.statusCode, response.body).toBe(204);
    },
    async endMeeting(slug, hostCookie) {
      const response = await app.inject({
        method: 'POST', url: `/api/v1/meetings/${slug}/end`,
        headers: { origin: config.publicBaseUrl.origin, cookie: hostCookie }
      });
      expect(response.statusCode, response.body).toBe(204);
    },
    connect(slug, cookie) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/meetings/${slug}/p2p`, {
          headers: { cookie }
        });
        // Buffer frames from the very start: with ws >= 8.18 the server's
        // first frame (welcome) can be emitted synchronously before 'open',
        // so listeners attached after awaiting 'open' would miss it.
        (ws as unknown as { __p2pMessages: unknown[] }).__p2pMessages = [];
        ws.on('message', (data) => {
          try {
            (ws as unknown as { __p2pMessages: unknown[] }).__p2pMessages.push(JSON.parse(String(data)));
          } catch {
            // ignore frames that are not JSON
          }
        });
        ws.once('open', () => resolve(ws));
        ws.once('error', (error) => reject(error));
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

interface Inbox {
  messages: unknown[];
  waitFor(predicate: (message: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  closed(): Promise<{ code: number }>;
}

function collect(ws: WebSocket): Inbox {
  const messages: unknown[] = (ws as unknown as { __p2pMessages: unknown[] }).__p2pMessages ?? [];
  if (messages.length === 0 && !(ws as unknown as { __p2pMessages: unknown[] }).__p2pMessages) {
    (ws as unknown as { __p2pMessages: unknown[] }).__p2pMessages = messages;
    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(String(data)));
      } catch {
        // ignore frames that are not JSON
      }
    });
  }
  return {
    messages,
    waitFor(predicate, timeoutMs = 2_000) {
      return new Promise((resolve, reject) => {
        const existing = messages.find(predicate);
        if (existing) { resolve(existing); return; }
        const timer = setTimeout(() => {
          ws.off('message', onMessage);
          reject(new Error('timed out waiting for message'));
        }, timeoutMs);
        const onMessage = () => {
          const found = messages.find(predicate);
          if (found) {
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve(found);
          }
        };
        ws.on('message', onMessage);
      });
    },
    closed(timeoutMs = 2_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
        ws.once('close', (code: number) => {
          clearTimeout(timer);
          resolve({ code });
        });
      });
    }
  };
}

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
