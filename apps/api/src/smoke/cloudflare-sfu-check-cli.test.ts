import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyCloudflareSfu } from './cloudflare-sfu-check-cli.js';

afterEach(() => vi.unstubAllGlobals());
describe('deployment SFU authentication probe', () => {
  it('authenticates against a single empty session and returns no session id or secret', async () => {
    const fetcher = vi.fn(async () => Response.json({ sessionId: 'private-session-id' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await verifyCloudflareSfu({ cloudflareSfuAppId: 'app', cloudflareSfuAppSecret: 'private-secret' })).toBe('CLOUDFLARE_SFU_AUTH_OK');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('https://rtc.live.cloudflare.com/v1/apps/app/sessions/new');
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
  });
  it('requires configured SFU and fails upstream authentication without exposing error text', async () => {
    await expect(verifyCloudflareSfu({})).rejects.toThrow('MEDIA_SERVICE_UNAVAILABLE');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'private-secret' }, { status: 401 })));
    await expect(verifyCloudflareSfu({ cloudflareSfuAppId: 'app', cloudflareSfuAppSecret: 'private-secret' })).rejects.toThrow('MEDIA_SERVICE_UNAVAILABLE');
  });
  it('uses the configured gateway for the single deployment probe allocation', async () => {
    const fetcher = vi.fn(async () => Response.json({ sessionId: 'private-session-id' }));
    vi.stubGlobal('fetch', fetcher);
    expect(await verifyCloudflareSfu({ cloudflareSfuGatewayUrl: 'https://p2p.babagan.cloud/api/sfu' })).toBe('CLOUDFLARE_SFU_AUTH_OK');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('https://p2p.babagan.cloud/api/sfu/sessions/new');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
  });
});
