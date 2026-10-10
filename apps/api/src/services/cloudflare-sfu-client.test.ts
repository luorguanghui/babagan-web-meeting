import { describe, expect, it, vi, afterEach } from 'vitest';
import { CloudflareSfuClient } from './cloudflare-sfu-client.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Cloudflare fixed-origin SFU client', () => {
  it('retains partial track results even with a request error so cleanup knows new receiving mids', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ errorCode: 'partial', tracks: [{ mid: '17', trackName: 'video' }] })));
    const result = await new CloudflareSfuClient({ appId: 'app', appSecret: 'private' }).newTracks('session', { tracks: [{ location: 'remote', trackName: 'video', sessionId: 'publisher' }] });
    expect(result).toMatchObject({ errorCode: 'partial', tracks: [{ mid: '17' }] });
  });
  it('checks individual forced close results and retains unreported or failed mids', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tracks: [{ mid: '0' }, { mid: '1', errorCode: 'close_track_error' }, { mid: '2', errorCode: 'internal_error' }] })));
    expect(await new CloudflareSfuClient({ appId: 'app', appSecret: 'private' }).closeTracks('session', ['0', '1', '2', '3'])).toEqual(['2', '3']);
  });
  it('uses fixed verified HTTPS, an empty new-session body, and rejects redirects or invalid ids', async () => {
    const fetcher = vi.fn(async () => Response.json({ sessionId: 'session' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await new CloudflareSfuClient({ appId: 'app', appSecret: 'private' }).createSession()).toBe('session');
    expect(fetcher).toHaveBeenCalledWith('https://rtc.live.cloudflare.com/v1/apps/app/sessions/new', expect.objectContaining({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer private' } }));
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
    expect(() => new CloudflareSfuClient({ appId: '../other', appSecret: 'private' })).toThrow();
  });
  it('aborts upstream timeouts without retrying allocation or exposing upstream error details', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('private-secret endpoint-sdp')));
    }));
    vi.stubGlobal('fetch', fetcher);
    await expect(new CloudflareSfuClient({ appId: 'app', appSecret: 'private', timeoutMs: 5 }).createSession()).rejects.toThrow('MEDIA_SERVICE_UNAVAILABLE');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    'https://p2p.babagan.cloud/api/sfu',
    'https://babagan-p2p.1312479965.workers.dev/api/sfu'
  ])('uses only the existing Worker route %s without forwarding API credentials', async (gatewayUrl) => {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ sessionId: 'session', tracks: [{ mid: '0' }] });
    });
    const client = new CloudflareSfuClient({ appId: 'own-app', appSecret: 'private', gatewayUrl });
    expect(await client.createSession()).toBe('session');
    await client.newTracks('session', { tracks: [{ location: 'local', mid: '0', trackName: 'video' }] });
    await client.answer('session', { type: 'answer', sdp: 'private-sdp' });
    expect(await client.closeTracks('session', ['0'])).toEqual([]);
    expect(await client.getSessionMids('session')).toEqual(['0']);
    expect(requests.map(({ url }) => url)).toEqual([
      `${gatewayUrl}/sessions/new`,
      `${gatewayUrl}/sessions/session/tracks/new`,
      `${gatewayUrl}/sessions/session/renegotiate`,
      `${gatewayUrl}/sessions/session/tracks/close`,
      `${gatewayUrl}/sessions/session`
    ]);
    expect(requests[0].init).not.toHaveProperty('body');
    for (const { init } of requests) {
      expect(init.redirect).toBe('error');
      expect(new Headers(init.headers).has('Authorization')).toBe(false);
    }
  });
  it('allocates through the gateway with no server SFU credentials configured', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { requests.push({ url, init }); return Response.json({ sessionId: 'session' }); });
    expect(await new CloudflareSfuClient({ gatewayUrl: 'https://p2p.babagan.cloud/api/sfu' }).createSession()).toBe('session');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://p2p.babagan.cloud/api/sfu/sessions/new');
    expect(new Headers(requests[0].init.headers).has('Authorization')).toBe(false);
  });
  it.each([{}, { appId: 'app' }, { appSecret: 'private' }])('requires both credentials for direct SFU access (%j)', (options) => {
    expect(() => new CloudflareSfuClient(options)).toThrow(/SFU credentials/);
  });
  it.each([
    'https://untrusted.example/api/sfu',
    'https://private@p2p.babagan.cloud/api/sfu',
    'https://p2p.babagan.cloud/api/sfu/v1/apps/other',
    'https://p2p.babagan.cloud/api/sfu?upstream=other'
  ])('rejects unsafe gateway client configuration %s before sending credentials', (gatewayUrl) => {
    expect(() => new CloudflareSfuClient({ appId: 'app', appSecret: 'private', gatewayUrl })).toThrow(/CLOUDFLARE_SFU_GATEWAY_URL/);
  });
  it('does not fall back to direct SFU after the gateway fails', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'private-secret private-sdp' }, { status: 502 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(new CloudflareSfuClient({ appId: 'app', appSecret: 'private', gatewayUrl: 'https://p2p.babagan.cloud/api/sfu' }).createSession()).rejects.toThrow('MEDIA_SERVICE_UNAVAILABLE');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    { gatewayUrl: undefined, budget: 10_000 },
    { gatewayUrl: 'https://p2p.babagan.cloud/api/sfu', budget: 15_000 }
  ])('aborts at the bounded default request budget $budget', async ({ gatewayUrl, budget }) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal!;
      signal.addEventListener('abort', () => reject(new Error('private-secret')));
    }));
    const request = new CloudflareSfuClient({ appId: 'app', appSecret: 'private', gatewayUrl }).createSession();
    const settled = request.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(budget - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toMatchObject({ message: 'MEDIA_SERVICE_UNAVAILABLE' });
    expect(signal?.aborted).toBe(true);
  });
});
