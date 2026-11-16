import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../../test/fakes/fake-clock.js';
import { FakeIds } from '../../../test/fakes/fake-ids.js';
import { FakeMediaService } from '../../../test/fakes/fake-media-service.js';
import { buildApp } from '../../app.js';
import type { AppConfig } from '../../config.js';
import { createDatabase } from '../../db/database.js';
import { migrate } from '../../db/migrate.js';
import { SqliteMoqRelayJournal } from '../../repositories/sqlite-moq-relay-journal.js';
import { SqliteMeetingRepository } from '../../repositories/sqlite-meeting-repository.js';
import { HostApplicationService } from '../../services/host-application-service.js';
import { KeyedMutex } from '../../services/keyed-mutex.js';
import { MeetingService } from '../../services/meeting-service.js';
import { ParticipantApplicationService } from '../../services/participant-application-service.js';

const config: AppConfig = {
  nodeEnv: 'test', publicBaseUrl: new URL('https://meet.example.test'),
  livekitUrl: new URL('wss://rtc.example.test'), livekitInternalUrl: new URL('ws://livekit.internal'),
  livekitApiKey: 'key', livekitApiSecret: 'secret', adminPasswordHash: 'admin-secret',
  cookieSecret: 'a'.repeat(32), databasePath: ':memory:',
  p2pStunUrls: [], p2pTurnUrls: [], p2pTurnSecret: 'a'.repeat(32), p2pTurnTtlSeconds: 600,
  meetingTtlMs: 86_400_000, emptyGraceMs: 600_000, reconnectGraceMs: 30_000,
  reservationTtlMs: 60_000, maxParticipants: 5
};

describe('Cloudflare MoQ screen share routes', () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  let request: ReturnType<typeof vi.fn<typeof fetch>>;
  let relayCount: number;
  let tokenCount: number;

  beforeEach(async () => {
    relayCount = tokenCount = 0;
    request = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === 'POST' && path.endsWith('/relays')) {
        return success({ uid: 'relay-' + ++relayCount });
      }
      if (init?.method === 'POST' && path.endsWith('/tokens')) {
        const { operations, label, expires } = JSON.parse(String(init.body));
        const jti = 'token-' + ++tokenCount;
        return success({ issuers: [{ type: 'cloudflare_jwt', cloudflare_tokens: [
          { jti: 'existing-token', label: 'default' },
          { jti, label, operations, expires, secret: 'connection-' + jti }
        ] }] });
      }
      if (init?.method === 'DELETE') return success({});
      throw new Error('Unexpected Cloudflare request');
    });
    vi.stubGlobal('fetch', request);
    fixture = await createFixture(true);
  });
  afterEach(async () => {
    await fixture.close();
    vi.unstubAllGlobals();
  });

  it('requires a participant session and reports disabled when credentials are absent', async () => {
    await fixture.close();
    fixture = await createFixture(false);
    const { slug, viewer } = await fixture.meeting();
    expect((await fixture.call(slug, '')).statusCode).toBe(401);
    expect((await fixture.call(slug, viewer)).json()).toEqual({ available: false, publication: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('issues a masked catalog and an expiring subscribe-only URL to the current meeting viewer', async () => {
    const { slug, owner, viewer, ownerIdentity } = await fixture.meeting();
    expect((await fixture.call(slug, viewer, '/publish', 'POST')).statusCode).toBe(403);
    expect(request).not.toHaveBeenCalled();
    const publish = await fixture.call(slug, owner, '/publish', 'POST');
    expect(publish.statusCode, publish.body).toBe(200);
    expect(publish.headers['cache-control']).toBe('no-store');
    const { shareId, namespace, url } = publish.json();
    expect(url).toBe('https://draft-18.cloudflare.mediaoverquic.com/connection-token-1');
    expect(namespace).toBe('screen.hang');
    expect((await fixture.call(slug, owner, '/publish', 'POST')).json()).toEqual(publish.json());
    expect((await fixture.call(slug, viewer)).json()).toEqual({ available: true, publication: null });
    expect((await fixture.call(slug, viewer, '/subscribe', 'POST', { shareId })).statusCode).toBe(403);
    expect((await fixture.call(slug, viewer, '/publications/' + shareId, 'PUT')).statusCode).toBe(403);
    expect((await fixture.call(slug, owner, '/publications/' + shareId, 'PUT')).statusCode).toBe(204);
    expect((await fixture.call(slug, viewer)).json()).toEqual({
      available: true, publication: { shareId, namespace, sharerIdentity: ownerIdentity, sharerName: 'Ada' }
    });
    const other = await fixture.meeting();
    expect((await fixture.call(other.slug, other.viewer, '/subscribe', 'POST', { shareId })).statusCode).toBe(403);
    expect((await fixture.call(slug, other.viewer, '/subscribe', 'POST', { shareId })).statusCode).toBe(401);
    const subscribe = await fixture.call(slug, viewer, '/subscribe', 'POST', { shareId });
    expect(subscribe.headers['cache-control']).toBe('no-store');
    expect(subscribe.json()).toEqual({ shareId, namespace, url: 'https://draft-18.cloudflare.mediaoverquic.com/connection-token-2' });
    expect((await fixture.call(slug, viewer, '/subscribe', 'POST', { shareId })).json()).toEqual(subscribe.json());
    const tokens = request.mock.calls.filter(([input]) => String(input).endsWith('/tokens'));
    expect(tokens.map(([, init]) => JSON.parse(String(init?.body)).operations)).toEqual([['publish', 'subscribe'], ['subscribe']]);
    expect(tokens.every(([, init]) => Date.parse(JSON.parse(String(init?.body)).expires) < Date.now() + 600_000)).toBe(true);
    expect(tokens.every(([input]) => String(input).includes('/relays/relay-1/'))).toBe(true);
    expect((await fixture.call(slug, viewer, '/publications/' + shareId, 'DELETE')).statusCode).toBe(403);
    expect((await fixture.call(slug, owner, '/publications/' + shareId, 'DELETE')).statusCode).toBe(204);
    expect(deletedPaths()).toContain('/moq/relays/relay-1');
    expect((await fixture.call(slug, viewer)).json().publication).toBeNull();
  });

  it('withdraws the relay when a previously credentialed viewer is kicked', async () => {
    const { slug, owner, viewer, host, viewerIdentity } = await fixture.meeting();
    const { shareId } = (await fixture.call(slug, owner, '/publish', 'POST')).json();
    const publication = '/publications/' + shareId;
    await fixture.call(slug, owner, publication, 'PUT');
    await fixture.call(slug, viewer, '/subscribe', 'POST', { shareId });
    await fixture.meetingCall(slug, host, '/kick', 'POST', { participantIdentity: viewerIdentity });
    expect(deletedPaths()).toContain('/moq/relays/relay-1');
    expect((await fixture.call(slug, viewer, '/subscribe', 'POST', { shareId })).statusCode).toBe(401);
    expect((await fixture.call(slug, owner, publication, 'PUT')).statusCode).toBe(403);
  });

  it('withdraws after the renewed lease expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    try {
      const { slug, owner } = await fixture.meeting();
      const { shareId } = (await fixture.call(slug, owner, '/publish', 'POST')).json();
      const publication = '/publications/' + shareId;
      await fixture.call(slug, owner, publication, 'PUT');
      vi.setSystemTime(75_000);
      expect((await fixture.call(slug, owner, publication, 'PUT')).statusCode).toBe(204);
      vi.setSystemTime(150_000);
      expect((await fixture.call(slug, owner)).json().publication).toMatchObject({ shareId });
      vi.setSystemTime(166_000);
      expect((await fixture.call(slug, owner, publication, 'PUT')).statusCode).toBe(403);
      expect((await fixture.call(slug, owner)).json().publication).toBeNull();
      expect(deletedPaths()).toContain('/moq/relays/relay-1');
    } finally { vi.useRealTimers(); }
  });

  it('releases a relay provisioned while the same participant was revoked and granted again', async () => {
    const { slug, owner, ownerIdentity, host } = await fixture.meeting();
    const entered = Promise.withResolvers<void>();
    const created = Promise.withResolvers<Response>();
    request.mockImplementationOnce(() => { entered.resolve(); return created.promise; });
    const publish = fixture.call(slug, owner, '/publish', 'POST');
    await entered.promise;
    const current = fixture.repo.findBySlug(slug)!;
    // Exercise a revoked and replaced grant between the two application-side
    // auth checks, using the same persisted transitions as the host service.
    fixture.repo.clearShareIdentityIfMatches(current.id, ownerIdentity);
    const revoked = fixture.repo.findBySlug(slug)!;
    fixture.repo.trySetShareIdentity(revoked.id, revoked.version, ownerIdentity);
    created.resolve(success({ uid: 'old-relay' }));
    expect((await publish).statusCode).toBe(403);
    expect(deletedPaths()).toContain('/moq/relays/old-relay');
    expect((await fixture.call(slug, owner, '/publish', 'POST')).statusCode).toBe(200);
    expect((await fixture.meetingCall(slug, host, '/share-grant', 'DELETE')).statusCode).toBe(204);
    expect(deletedPaths()).toContain('/moq/relays/relay-1');
  });

  it('reclaims a relay whose ID was recorded before the API restarted', async () => {
    await fixture.close();
    fixture = await createFixture(true, { name: 'meeting-screen-previous-process', createdAt: Date.now(), id: 'previous-relay' });
    await vi.waitFor(() => expect(deletedPaths()).toContain('/moq/relays/previous-relay'), { timeout: 500 });
    expect(fixture.journal.list()).toEqual([]);
  });

  it('looks up and deletes a relay after an ambiguous create response', async () => {
    const { slug, owner } = await fixture.meeting();
    let name = '';
    request.mockImplementationOnce(async (_url, init) => {
      name = JSON.parse(String(init?.body)).name;
      throw new Error('network failure with unknown result');
    });
    const response = await fixture.call(slug, owner, '/publish', 'POST');
    expect(response.statusCode).toBe(503);
    const { pathname } = new URL(String(request.mock.calls[0][0]));
    expect(pathname).toBe('/client/v4/accounts/account-id/moq/relays');
    request.mockResolvedValueOnce(success([{ name: 'another-relay', uid: 'not-ours' }, { name, uid: 'late-relay' }]));
    await fixture.close();
    expect(deletedPaths()).toEqual(['/moq/relays/late-relay']);
  });

  it('withdraws a partial allocation after a provider failure without disclosing its response', async () => {
    const { slug, owner } = await fixture.meeting();
    request.mockResolvedValueOnce(success({ uid: 'partial-relay' }));
    request.mockResolvedValueOnce(Response.json({ success: false, errors: [{ message: 'private-provider-token' }] }, { status: 400 }));
    const response = await fixture.call(slug, owner, '/publish', 'POST');
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private-provider-token');
    expect(deletedPaths()).toContain('/moq/relays/partial-relay');
    expect((await fixture.call(slug, owner)).json().publication).toBeNull();
  });

  function deletedPaths() {
    return request.mock.calls.filter(([, init]) => init?.method === 'DELETE')
      .map(([input]) => new URL(String(input)).pathname.replace('/client/v4/accounts/account-id', ''));
  }
});

function success(result: object) { return Response.json({ success: true, result, errors: [], messages: [] }); }

async function createFixture(enabled: boolean, orphaned?: { name: string; createdAt: number; id: string }) {
  const fixtureConfig = enabled ? {
    ...config, cloudflareMoqAccountId: 'account-id', cloudflareMoqApiToken: 'management-secret'
  } : config;
  const db = createDatabase(':memory:');
  migrate(db);
  const repo = new SqliteMeetingRepository(db);
  const journal = new SqliteMoqRelayJournal(db, 'account-id');
  if (orphaned) journal.save(orphaned);
  const clock = new FakeClock(1_000);
  const ids = new FakeIds();
  ids.slug = randomUUID;
  const media = new FakeMediaService();
  const passwords = {
    async verify(expected: string, value: string) { return expected === value; },
    async hash(value: string) { return value; }
  };
  const mutex = new KeyedMutex();
  const dependencies = { repository: repo, passwords, clock, ids, config: fixtureConfig };
  const meetings = new MeetingService({ ...dependencies, mutex, media: {
    listParticipantIdentities: async (meetingId) => [...await media.listParticipantIdentities(meetingId)],
    issueParticipantToken: (input) => media.issueToken(input)
  } });
  const hosts = new HostApplicationService({ ...dependencies, meetings, media, mutex });
  const participants = new ParticipantApplicationService({ ...dependencies, media });
  const app = await buildApp({ config: fixtureConfig, meetings, hosts, participants, media, screenMoqJournal: journal, webhooks: { async handle() { return {}; } } });
  function meetingCall(slug: string, cookie: string, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', payload?: object) {
    return app.inject({ method, url: '/api/v1/meetings/' + slug + path,
      headers: { cookie, origin: config.publicBaseUrl.origin }, ...(payload ? { payload } : {}) });
  }
  let closed = false;
  return {
    repo, journal, meetingCall,
    call(slug: string, cookie: string, path = '', method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', payload?: object) {
      return meetingCall(slug, cookie, '/screen-moq' + path, method, payload);
    },
    async meeting() {
      const response = await app.inject({ method: 'POST', url: '/api/v1/meetings',
        headers: { origin: config.publicBaseUrl.origin }, payload: { name: 'Daily', adminPassword: 'admin-secret' } });
      expect(response.statusCode, response.body).toBe(201);
      const host = cookiePair(response.headers['set-cookie']);
      const { slug } = response.json();
      const owner = await meetingCall(slug, '', '/join', 'POST', { nickname: 'Ada' });
      const viewer = await meetingCall(slug, '', '/join', 'POST', { nickname: 'Bob' });
      expect(owner.statusCode, owner.body).toBe(200);
      expect(viewer.statusCode, viewer.body).toBe(200);
      const ownerIdentity = owner.json().participantIdentity;
      const viewerIdentity = viewer.json().participantIdentity;
      expect((await meetingCall(slug, host, '/share-grant', 'PUT', { participantIdentity: ownerIdentity })).statusCode).toBe(204);
      return { slug, host, owner: cookiePair(owner.headers['set-cookie']), viewer: cookiePair(viewer.headers['set-cookie']), ownerIdentity, viewerIdentity };
    },
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      db.close();
    }
  };
}

function cookiePair(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('Expected Set-Cookie header');
  return value.split(';', 1)[0];
}
