import { describe, expect, it, vi } from 'vitest';

import { fetchCloudflareTurnIceServers } from './cloudflare-turn.js';

describe('Cloudflare TURN credentials', () => {
  it('uses configured edge connect IPs while keeping the Cloudflare API hostname', async () => {
    const requestImpl = vi.fn(async (request: {
      url: URL;
      connectIp?: string;
      headers: Record<string, string>;
      body: string;
    }) => {
      expect(request.url.hostname).toBe('rtc.live.cloudflare.com');
      expect(request.connectIp).toBe('172.64.150.1');
      expect(request.headers.host).toBe('rtc.live.cloudflare.com');
      expect(JSON.parse(request.body)).toEqual({ ttl: 600 });
      return {
        status: 201,
        json: async () => ({
          iceServers: [{
            urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
            username: 'cloudflare-user',
            credential: 'cloudflare-credential'
          }]
        })
      };
    });
    const fetchImpl = vi.fn(async () => { throw new Error('legacy DNS path used'); });

    const result = await fetchCloudflareTurnIceServers({
      keyId: 'turn-key-id',
      apiToken: 'turn-api-token',
      ttlSeconds: 600,
      connectIps: ['172.64.150.1'],
      requestImpl,
      fetchImpl
    } as Parameters<typeof fetchCloudflareTurnIceServers>[0]);

    expect(result.turnProvider).toBe('cloudflare');
    expect(result.iceServers[0].username).toBe('cloudflare-user');
    expect(requestImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
