import { describe, expect, it, vi, afterEach } from 'vitest';
import { CloudflareSfuClient } from './cloudflare-sfu-client.js';

afterEach(() => vi.unstubAllGlobals());
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
});
