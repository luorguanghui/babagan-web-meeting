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
import type { WebhookHandleResult, WebhookHandler } from '../../livekit/webhook-handler.js';
import { SqliteMeetingRepository } from '../../repositories/sqlite-meeting-repository.js';
import { KeyedMutex } from '../../services/keyed-mutex.js';
import { HostApplicationService } from '../../services/host-application-service.js';
import type { IdGenerator, PasswordHasher } from '../../services/meeting-service.js';
import { MeetingService } from '../../services/meeting-service.js';
import { ParticipantApplicationService } from '../../services/participant-application-service.js';
import { P2pRoomRegistry } from '../../p2p/room-registry.js';
import { CloudflareSfuService } from '../../services/cloudflare-sfu.js';
import { CloudflareSfuClient } from '../../services/cloudflare-sfu-client.js';
import type { SfuTrack } from '../../services/cloudflare-sfu-client.js';
import { FakeClock } from '../../../test/fakes/fake-clock.js';

describe('Cloudflare SFU broker routes', () => {
  let fixture: IceFixture;
  let requests: Array<{ url: string; body: { tracks: SfuTrack[]; sessionDescription?: { type: string; sdp: string }; force?: boolean } }>;
  let next = 0;
  beforeEach(async () => {
    requests = []; next = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url: String(url), body });
      if (String(url).endsWith('/sessions/new')) return Response.json({ sessionId: `cf-${++next}` });
      if (String(url).endsWith('/tracks/new')) return Response.json({ sessionDescription: { type: body.sessionDescription ? 'answer' : 'offer', sdp: 'valid-sdp' }, requiresImmediateRenegotiation: !body.sessionDescription, tracks: body.tracks.map((t: SfuTrack, i: number) => ({ ...t, mid: t.mid ?? String(i) })) });
      if (String(url).endsWith('/tracks/close')) return Response.json({ tracks: body.tracks });
      return Response.json({});
    }));
    fixture = await createFixture({ cloudflareSfuAppId: 'app', cloudflareSfuAppSecret: 'secret' });
  });
  afterEach(async () => { await fixture.close(); vi.unstubAllGlobals(); });
  async function setup() {
    const { slug } = await fixture.createMeeting();
    const publisher = await fixture.join(slug, 'Ada');
    const viewer = await fixture.join(slug, 'Bob');
    await fixture.app.inject({ method: 'PUT', url: `/api/v1/meetings/${slug}/share-grant`, headers: { cookie: fixture.hostCookie, origin: config.publicBaseUrl.origin }, payload: { participantIdentity: publisher.json().participantIdentity } });
    return { slug, publisher: cookiePair(publisher.headers['set-cookie']), viewer: cookiePair(viewer.headers['set-cookie']) };
  }
  function call(slug: string, cookie: string, suffix = '', method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', payload?: object) {
    return fixture.app.inject({ method, url: `/api/v1/meetings/${slug}/screen-sfu${suffix}`, headers: { cookie, origin: config.publicBaseUrl.origin }, ...(payload === undefined ? {} : { payload }) });
  }
  const offer = { sessionDescription: { type: 'offer', sdp: 'endpoint-sdp' }, tracks: [{ kind: 'video', mid: '0' }, { kind: 'audio', mid: '1' }] };
  it('enables the app-created SFU service with gateway-only configuration', async () => {
    await fixture.close();
    fixture = await createFixture({ cloudflareSfuGatewayUrl: 'https://p2p.babagan.cloud/api/sfu' }, true);
    const f = await setup();
    expect((await call(f.slug, f.viewer)).json().available).toBe(true);
    expect((await call(f.slug, f.publisher, '/publish', 'POST', offer)).statusCode).toBe(200);
    expect(requests.map(({ url }) => url)).toEqual([
      'https://p2p.babagan.cloud/api/sfu/sessions/new',
      'https://p2p.babagan.cloud/api/sfu/sessions/cf-1/tracks/new'
    ]);
  });
  it('authenticates status and publish and enforces publisher lock', async () => {
    const f = await setup();
    expect((await call(f.slug, '')).statusCode).toBe(401);
    expect((await call(f.slug, f.viewer)).json()).toEqual({ available: true, publication: null });
    expect((await call(f.slug, f.viewer, '/publish', 'POST', offer)).statusCode).toBe(403);
    expect(requests).toEqual([]);
  });
  it('announces only ready publication, subscribes server catalog tracks, answers and closes owned sessions', async () => {
    const f = await setup();
    const publish = await call(f.slug, f.publisher, '/publish', 'POST', offer);
    expect(publish.statusCode, publish.body).toBe(200);
    const p = publish.json();
    expect(p.sessionDescription.type).toBe('answer');
    expect((await call(f.slug, f.viewer)).json().publication).toBeNull();
    expect((await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: p.sessionId })).statusCode).toBe(204);
    expect((await call(f.slug, f.viewer)).json().publication).toMatchObject({ shareId: p.shareId, sharerName: 'Ada' });
    const subscribe = await call(f.slug, f.viewer, '/subscribe', 'POST', { shareId: p.shareId });
    expect(subscribe.statusCode, subscribe.body).toBe(200);
    const v = subscribe.json();
    expect(v.sessionDescription.type).toBe('offer');
    expect(requests.find((r) => r.url.includes(v.sessionId) && r.url.endsWith('/tracks/new'))?.body.tracks).toEqual(p.tracks.map((t: SfuTrack) => ({ location: 'remote', sessionId: p.sessionId, trackName: t.trackName, kind: t.kind })));
    expect((await call(f.slug, f.publisher, `/sessions/${v.sessionId}`, 'DELETE')).statusCode).toBe(403);
    expect((await call(f.slug, f.viewer, `/sessions/${v.sessionId}/answer`, 'PUT', { sessionDescription: { type: 'answer', sdp: 'receiver-answer' } })).statusCode).toBe(204);
    expect((await call(f.slug, f.publisher, `/sessions/${p.sessionId}`, 'DELETE')).statusCode).toBe(204);
    expect((await call(f.slug, f.viewer)).json().publication).toBeNull();
    expect(requests.filter((r) => r.url.endsWith('/tracks/close'))).toHaveLength(2);
    expect((await call(f.slug, f.publisher, `/sessions/${p.sessionId}`, 'DELETE')).statusCode).toBe(204);
  });
  it('rejects foreign catalog names, old generations, duplicate mids, and extra body fields', async () => {
    const f = await setup();
    expect((await call(f.slug, f.viewer, '/subscribe', 'POST', { shareId: 'foreign' })).statusCode).toBe(403);
    expect((await call(f.slug, f.publisher, '/publish', 'POST', { ...offer, tracks: [{ kind: 'video', mid: '0' }, { kind: 'audio', mid: '0' }] })).statusCode).toBe(400);
    expect((await call(f.slug, f.publisher, '/publish', 'POST', { ...offer, appId: 'foreign' })).statusCode).toBe(400);
    expect(requests).toHaveLength(0);
  });
  it('cleans partial track allocation errors and returns a sanitized 503 without retrying', async () => {
    const f = await setup();
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/tracks/new')) {
        const body = JSON.parse(String(init!.body));
        requests.push({ url: String(url), body });
        return Response.json({ errorCode: 'private-secret', errorDescription: 'endpoint-sdp', tracks: body.tracks.map((t: SfuTrack) => ({ ...t, errorCode: t.kind === 'audio' ? 'track_error' : undefined })) });
      }
      return original(url, init);
    }));
    const response = await call(f.slug, f.publisher, '/publish', 'POST', offer);
    expect(response.statusCode, response.body).toBe(503);
    expect(response.body).not.toContain('private-secret');
    expect(response.body).not.toContain('endpoint-sdp');
    expect(requests.filter((r) => r.url.endsWith('/tracks/new'))).toHaveLength(1);
    expect(requests.find((r) => r.url.endsWith('/tracks/close'))?.body).toEqual({ force: true, tracks: [{ mid: '0' }, { mid: '1' }] });
    expect((await call(f.slug, f.viewer)).json().publication).toBeNull();
  });
  it('allows the browser readiness budget after a slow successful track allocation', async () => {
    const f = await setup();
    const original = globalThis.fetch;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/tracks/new')) vi.setSystemTime(Date.now() + 8_000);
        return original(url, init);
      }));
      const publish = await call(f.slug, f.publisher, '/publish', 'POST', offer);
      expect(publish.statusCode).toBe(200);
      vi.setSystemTime(Date.now() + 22_000);
      expect((await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: publish.json().sessionId })).statusCode).toBe(204);
    } finally { vi.useRealTimers(); }
  });
  it('removes pending allocations after thirty seconds and rejects late ready', async () => {
    const f = await setup();
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      expect((await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: p.sessionId })).statusCode).toBe(403);
      expect(requests.filter((r) => r.url.endsWith('/tracks/close'))).toHaveLength(1);
      expect((await call(f.slug, f.viewer)).json().publication).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('lets four viewers complete slow independent negotiations within their own deadlines', async () => {
    const f = await setup();
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: p.sessionId });
    const viewers = [f.viewer];
    for (let i = 2; i <= 4; i++) viewers.push(cookiePair((await fixture.join(f.slug, `Viewer ${i}`)).headers['set-cookie']));
    const original = globalThis.fetch;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let started = 0;
    let allStarted!: () => void;
    const starting = new Promise<void>(resolve => { allStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/sessions/new')) {
        if (++started === 4) allStarted();
        await new Promise(resolve => setTimeout(resolve, 8000));
      }
      if (String(url).endsWith('/tracks/new')) await new Promise(resolve => setTimeout(resolve, 9000));
      return original(url, init);
    }));
    const allocations: number[] = [];
    const results = viewers.map(cookie => call(f.slug, cookie, '/subscribe', 'POST', { shareId: p.shareId }).then(async response => {
      allocations.push(response.statusCode);
      if (response.statusCode !== 200) return response.statusCode;
      return (await call(f.slug, cookie, `/sessions/${response.json().sessionId}/answer`, 'PUT', { sessionDescription: { type: 'answer', sdp: 'receiver-answer' } })).statusCode;
    }));
    try {
      await starting;
      await vi.advanceTimersByTimeAsync(17001);
      await new Promise(resolve => setImmediate(resolve));
      expect(allocations).toEqual([200, 200, 200, 200]);
      expect(await Promise.all(results)).toEqual([204, 204, 204, 204]);
    } finally {
      await vi.advanceTimersByTimeAsync(100000);
      vi.useRealTimers();
      vi.stubGlobal('fetch', original);
      await Promise.all(results);
    }
  });
  it('drains cleanup after failed closes and a sharer handoff without nested owner deadlock', async () => {
    const f = await setup();
    const a = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: a.sessionId });
    await call(f.slug, f.viewer, '/subscribe', 'POST', { shareId: a.shareId });
    const original = globalThis.fetch;
    let failClose = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (failClose && String(url).endsWith('/tracks/close')) return new Response('', { status: 503 });
      return original(url, init);
    }));
    await call(f.slug, f.publisher, `/sessions/${a.sessionId}`, 'DELETE');
    await fixture.app.inject({ method: 'DELETE', url: `/api/v1/meetings/${f.slug}/share`, headers: { cookie: f.publisher, origin: config.publicBaseUrl.origin } });
    // Fixture session identities are stable; grant the second participant directly
    // through the same host authority route used by the product.
    const identities = fixture.db.prepare('SELECT identity FROM participant_sessions WHERE nickname=?').all('Bob') as Array<{ identity: string }>;
    const grant = await fixture.app.inject({ method: 'PUT', url: `/api/v1/meetings/${f.slug}/share-grant`, headers: { cookie: fixture.hostCookie, origin: config.publicBaseUrl.origin }, payload: { participantIdentity: identities[0].identity } });
    expect(grant.statusCode).toBe(204);
    const b = (await call(f.slug, f.viewer, '/publish', 'POST', offer)).json();
    await call(f.slug, f.viewer, '/publish/ready', 'POST', { sessionId: b.sessionId });
    expect((await call(f.slug, f.publisher, '/subscribe', 'POST', { shareId: b.shareId })).statusCode).toBe(200);
    failClose = false;
    await fixture.screenSfu.closeMeeting(f.slug);
    expect((await call(f.slug, f.viewer)).json().publication).toBeNull();
  });
  it('allows a new publication after Cloudflare explicitly reports the old session gone', async () => {
    const f = await setup();
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: p.sessionId });
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes(`/sessions/${p.sessionId}/tracks/close`)) return Response.json({ errorCode: 'session_error' }, { status: 410 });
      return original(url, init);
    }));
    expect((await call(f.slug, f.publisher, `/sessions/${p.sessionId}`, 'DELETE')).statusCode).toBe(204);
    const next = await call(f.slug, f.publisher, '/publish', 'POST', offer);
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().sessionId).not.toBe(p.sessionId);
  });
  it('retires an uncertain allocation when an owned inspection proves its session expired', async () => {
    const f = await setup();
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: p.sessionId });
    const original = globalThis.fetch;
    let failViewer = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/sessions/cf-2') && init?.method === 'GET') return Response.json({ errorCode: 'session_error' }, { status: 410 });
      if (String(url).endsWith('/tracks/new') && !JSON.parse(String(init?.body)).sessionDescription && failViewer) {
        failViewer = false; return new Response('', { status: 503 });
      }
      return original(url, init);
    }));
    expect((await call(f.slug, f.viewer, '/subscribe', 'POST', { shareId: p.shareId })).statusCode).toBe(503);
    expect((await call(f.slug, f.viewer, '/subscribe', 'POST', { shareId: p.shareId })).statusCode).toBe(200);
  });
  it('cleans a late upstream allocation when its share grant is revoked during the request', async () => {
    const f = await setup();
    let started!: () => void; const inFlight = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void; const resume = new Promise<void>((resolve) => { finish = resolve; });
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/tracks/new')) { started(); await resume; }
      return original(url, init);
    }));
    const publish = call(f.slug, f.publisher, '/publish', 'POST', offer);
    await inFlight;
    const revoke = fixture.app.inject({ method: 'DELETE', url: `/api/v1/meetings/${f.slug}/share-grant`, headers: { origin: config.publicBaseUrl.origin, cookie: fixture.hostCookie } });
    // Wait until the existing authority has revoked the lock; cleanup waits behind allocation.
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    expect((await publish).statusCode).toBe(403);
    expect((await revoke).statusCode).toBe(204);
    expect(requests.filter((r) => r.url.endsWith('/tracks/close'))).toHaveLength(1);
    expect((await call(f.slug, f.viewer)).json().publication).toBeNull();
  });
  it('rejects ownership even after a session has closed, while owner repeat stop stays idempotent', async () => {
    const f = await setup();
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    await call(f.slug, f.publisher, `/sessions/${p.sessionId}`, 'DELETE');
    expect((await call(f.slug, f.viewer, `/sessions/${p.sessionId}`, 'DELETE')).statusCode).toBe(403);
    expect((await call(f.slug, f.publisher, `/sessions/${p.sessionId}`, 'DELETE')).statusCode).toBe(204);
  });
  it('rejects a different meeting even with a valid cookie and rejects a wrong Origin', async () => {
    const f = await setup();
    expect((await call('abcdefghijklmnopqrstuv', f.viewer)).statusCode).toBe(404);
    expect((await fixture.app.inject({ method: 'POST', url: `/api/v1/meetings/${f.slug}/screen-sfu/publish`, headers: { cookie: f.publisher, origin: 'https://other.example.test' }, payload: offer })).statusCode).toBe(403);
    expect(requests).toHaveLength(0);
  });  it.each(['leave', 'kick', 'end'])('closes publication and receiving sessions on %s', async (operation) => {
    const f = await setup();
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: p.sessionId });
    await call(f.slug, f.viewer, '/subscribe', 'POST', { shareId: p.shareId });
    const response = await fixture.app.inject({ method: 'POST', url: `/api/v1/meetings/${f.slug}/${operation}`, headers: { origin: config.publicBaseUrl.origin, cookie: operation === 'leave' ? f.publisher : fixture.hostCookie }, ...(operation === 'kick' ? { payload: { participantIdentity: 'participant-1' } } : {}) });
    expect(response.statusCode, response.body).toBe(204);
    expect(requests.filter((r) => r.url.endsWith('/tracks/close'))).toHaveLength(2);
  });
  it('replaces reconnecting viewers and publishers and rejects stale generations', async () => {
    const f = await setup();
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: p.sessionId });
    const v1 = (await call(f.slug, f.viewer, '/subscribe', 'POST', { shareId: p.shareId })).json();
    const v2 = (await call(f.slug, f.viewer, '/subscribe', 'POST', { shareId: p.shareId })).json();
    expect(v2.sessionId).not.toBe(v1.sessionId);
    expect((await call(f.slug, f.viewer, `/sessions/${v1.sessionId}/answer`, 'PUT', { sessionDescription: { type: 'answer', sdp: 'stale' } })).statusCode).toBe(403);
    const p2 = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    expect(p2.shareId).not.toBe(p.shareId);
    expect((await call(f.slug, f.viewer, '/subscribe', 'POST', { shareId: p.shareId })).statusCode).toBe(403);
    expect(requests.filter((r) => r.url.endsWith('/tracks/close'))).toHaveLength(3);
  });
  it('retains failed forced closes and refuses to allocate another session for the same owner', async () => {
    const f = await setup();
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/tracks/close')) {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ tracks: [{ mid: '0' }, { mid: '1', errorCode: 'temporarily_unavailable' }] });
      }
      return original(url, init);
    }));
    expect((await call(f.slug, f.publisher, `/sessions/${p.sessionId}`, 'DELETE')).statusCode).toBe(204);
    const busy = await call(f.slug, f.publisher, '/publish', 'POST', offer);
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toMatchObject({ error: { code: 'MEDIA_SERVICE_UNAVAILABLE', message: 'Cloudflare SFU cleanup is in progress; try again shortly' } });
    expect(busy.headers['retry-after']).toBe('5');
    expect(requests.filter((r) => r.url.endsWith('/sessions/new'))).toHaveLength(1);
    expect(requests.filter((r) => r.url.endsWith('/tracks/close')).at(-1)?.body.tracks).toEqual([{ mid: '1' }]);
    vi.stubGlobal('fetch', original);
    await call(f.slug, f.viewer);
    expect((await call(f.slug, f.publisher, '/publish', 'POST', offer)).statusCode).toBe(200);
  });
  it('returns unavailable when server SFU is unconfigured', async () => {
    await fixture.close(); fixture = await createFixture();
    const f = await setup();
    expect((await call(f.slug, f.viewer)).json()).toEqual({ available: false, publication: null });
    expect((await call(f.slug, f.publisher, '/publish', 'POST', offer)).statusCode).toBe(503);
    expect(requests).toHaveLength(0);
  });
  it('closes known tracks when the app shuts down', async () => {
    const f = await setup();
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: p.sessionId });
    await call(f.slug, f.viewer, '/subscribe', 'POST', { shareId: p.shareId });
    await fixture.app.close();
    expect(requests.filter((r) => r.url.endsWith('/tracks/close'))).toHaveLength(2);
  });
  it('reports malformed Cloudflare allocation results as a sanitized 503', async () => {
    const f = await setup();
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => String(url).endsWith('/tracks/new') ? Response.json({ tracks: { private: 'secret' } }) : original(url, init)));
    const response = await call(f.slug, f.publisher, '/publish', 'POST', offer);
    expect(response.statusCode, response.body).toBe(503);
  });
  it('keeps uncertain viewer allocations queued, inspects late mids, and never retries tracks/new', async () => {
    const f = await setup();
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: p.sessionId });
    const original = globalThis.fetch;
    let inspection = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('cf-2') && String(url).endsWith('/tracks/new')) {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        throw new Error('Uncertain allocation timeout');
      }
      if (String(url).endsWith('/sessions/cf-2') && init?.method === 'GET') {
        inspection++;
        return Response.json({ tracks: inspection === 1 ? [] : [{ mid: '7', trackName: p.tracks[0].trackName, status: 'active' }] });
      }
      return original(url, init);
    }));
    expect((await call(f.slug, f.viewer, '/subscribe', 'POST', { shareId: p.shareId })).statusCode).toBe(503);
    await call(f.slug, f.publisher);
    expect(requests.find((r) => r.url.includes('cf-2') && r.url.endsWith('/tracks/close'))?.body).toEqual({ force: true, tracks: [{ mid: '7' }] });
    expect(requests.filter((r) => r.url.includes('cf-2') && r.url.endsWith('/tracks/new'))).toHaveLength(1);
    expect(inspection).toBeGreaterThanOrEqual(2);
  });
  it('still force-closes known publisher mids when allocation and resource inspection fail', async () => {
    const f = await setup();
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/tracks/new') || (String(url).endsWith('/sessions/cf-1') && init?.method === 'GET')) throw new Error('network timeout');
      return original(url, init);
    }));
    expect((await call(f.slug, f.publisher, '/publish', 'POST', offer)).statusCode).toBe(503);
    expect(requests.find((r) => r.url.endsWith('/tracks/close'))?.body).toEqual({ force: true, tracks: [{ mid: '0' }, { mid: '1' }] });
  });
  it('uses one publisher allocation for four viewers with a five-session ceiling', async () => {
    const f = await setup();
    const viewers = [f.viewer];
    for (const name of ['Carol', 'Dave', 'Eve']) {
      const joined = await fixture.join(f.slug, name);
      expect(joined.statusCode).toBe(200);
      viewers.push(cookiePair(joined.headers['set-cookie']));
    }
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: p.sessionId });
    for (const viewer of viewers) {
      const response = await call(f.slug, viewer, '/subscribe', 'POST', { shareId: p.shareId });
      expect(response.statusCode, response.body).toBe(200);
      const v = response.json();
      expect((await call(f.slug, viewer, `/sessions/${v.sessionId}/answer`, 'PUT', { sessionDescription: { type: 'answer', sdp: 'viewer-answer' } })).statusCode).toBe(204);
    }
    expect(requests.filter((r) => r.url.endsWith('/sessions/new'))).toHaveLength(5);
    expect(requests.filter((r) => r.url.endsWith('/tracks/new') && r.body.sessionDescription)).toHaveLength(1);
    expect(requests.filter((r) => r.url.endsWith('/tracks/new') && !r.body.sessionDescription)).toHaveLength(4);
  });
  it('continues background cleanup after a sweep of an empty registry', async () => {
    await fixture.screenSfu.sweep();
    const f = await setup();
    await call(f.slug, f.publisher, '/publish', 'POST', offer);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      await fixture.screenSfu.sweep();
      expect(requests.filter((r) => r.url.endsWith('/tracks/close'))).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('coalesces background sweeps while slow cleanup remains in progress', async () => {
    const f = await setup();
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    const original = globalThis.fetch;
    let release!: () => void;
    let began!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { began = resolve; });
    let closeCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/tracks/close')) { closeCount++; return Response.json({ tracks: [{ mid: '0' }, { mid: '1', errorCode: 'unavailable' }] }); }
      return original(url, init);
    }));
    await call(f.slug, f.publisher, `/sessions/${p.sessionId}`, 'DELETE');
    closeCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/tracks/close')) { closeCount++; began(); await wait; return Response.json({ tracks: [{ mid: '1', errorCode: 'unavailable' }] }); }
      return original(url, init);
    }));
    const one = fixture.screenSfu.sweep();
    await started;
    const two = fixture.screenSfu.sweep();
    release();
    await Promise.all([one, two]);
    expect(closeCount).toBe(1);
    vi.stubGlobal('fetch', original);
  });
  it('closes revoked publisher and subscribers immediately', async () => {
    const f = await setup();
    const p = (await call(f.slug, f.publisher, '/publish', 'POST', offer)).json();
    await call(f.slug, f.publisher, '/publish/ready', 'POST', { sessionId: p.sessionId });
    await fixture.app.inject({ method: 'DELETE', url: `/api/v1/meetings/${f.slug}/share-grant`, headers: { origin: config.publicBaseUrl.origin, cookie: fixture.hostCookie } });
    expect((await call(f.slug, f.viewer)).json().publication).toBeNull();
    expect(requests.filter((r) => r.url.endsWith('/tracks/close'))).toHaveLength(1);
    expect((await call(f.slug, f.viewer, '/subscribe', 'POST', { shareId: p.shareId })).statusCode).toBe(403);
  });
});
interface IceFixture {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: Database.Database;
  directory: string;
  media: RouteMediaFake;
  hostCookie: string;
  screenSfu: CloudflareSfuService;
  createMeeting(): Promise<{ slug: string }>;
  join(slug: string, nickname: string): ReturnType<Awaited<ReturnType<typeof buildApp>>['inject']>;
  close(): Promise<void>;
}

type TestConfig = AppConfig;

async function createFixture(overrides: Partial<TestConfig> = {}, useAppCreatedSfu = false): Promise<IceFixture> {
  const fixtureConfig: TestConfig = { ...config, ...overrides };
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
    passwords, clock, ids, config: fixtureConfig, mutex
  });
  const hosts = new HostApplicationService({ repository, meetings, media, passwords, clock, ids, config: fixtureConfig, mutex });
  const participants = new ParticipantApplicationService({ repository, media, clock, ids, config: fixtureConfig });
  const p2p = new P2pRoomRegistry();
  const screenSfu = new CloudflareSfuService({ participants, registry: p2p,
    api: fixtureConfig.cloudflareSfuAppId && fixtureConfig.cloudflareSfuAppSecret ? new CloudflareSfuClient({ appId: fixtureConfig.cloudflareSfuAppId, appSecret: fixtureConfig.cloudflareSfuAppSecret }) : undefined
  });
  const app = await buildApp({
    config: fixtureConfig, meetings, hosts, participants, media, p2p, ...(useAppCreatedSfu ? {} : { screenSfu }), webhooks: new StubWebhookHandler()
  });

  return {
    app, db, directory, media, screenSfu, hostCookie: '',
    async createMeeting() {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/meetings', headers: { origin: fixtureConfig.publicBaseUrl.origin },
        payload: { adminPassword: 'admin-secret', name: 'Daily', meetingPassword: 'join-secret' }
      });
      this.hostCookie = cookiePair(response.headers['set-cookie']);
      return { slug: response.json().slug as string };
    },
    join(slug, nickname) {
      return app.inject({
        method: 'POST', url: `/api/v1/meetings/${slug}/join`,
        headers: { origin: fixtureConfig.publicBaseUrl.origin },
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
  async handle(): Promise<WebhookHandleResult> { return {}; }
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
