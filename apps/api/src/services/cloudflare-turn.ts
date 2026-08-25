import type { P2pTurnProvider } from '@meeting/contracts';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface TurnIceServerConfiguration {
  iceServers: IceServer[];
  turnProvider: P2pTurnProvider;
  turnCredentialsExpiresAt: number;
}

interface CloudflareIceServersResponse {
  iceServers?: unknown;
}

export async function fetchCloudflareTurnIceServers(input: {
  keyId: string;
  apiToken: string;
  ttlSeconds: number;
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}): Promise<TurnIceServerConfiguration> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(input.keyId)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ttl: input.ttlSeconds })
    }
  );
  if (!response.ok) throw new Error(`Cloudflare TURN credentials request failed with ${response.status}`);

  const payload = await response.json() as CloudflareIceServersResponse;
  const iceServers = normalizeCloudflareIceServers(payload.iceServers);
  const nowSeconds = input.nowSeconds ?? (() => Date.now() / 1_000);
  return {
    iceServers,
    turnProvider: 'cloudflare',
    turnCredentialsExpiresAt: Math.floor(nowSeconds()) + input.ttlSeconds
  };
}

export function normalizeCloudflareIceServers(value: unknown): IceServer[] {
  if (!Array.isArray(value)) throw new Error('Cloudflare TURN response contains no iceServers');
  const servers = value.flatMap((entry): IceServer[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const candidate = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = (Array.isArray(candidate.urls) ? candidate.urls : [candidate.urls])
      .filter((url): url is string => typeof url === 'string' && !isBrowserBlockedPort(url));
    if (urls.length === 0) return [];
    return [{
      urls,
      ...(typeof candidate.username === 'string' ? { username: candidate.username } : {}),
      ...(typeof candidate.credential === 'string' ? { credential: candidate.credential } : {})
    }];
  });
  if (servers.length === 0) throw new Error('Cloudflare TURN response contains no usable ICE servers');
  return servers;
}

function isBrowserBlockedPort(url: string): boolean {
  return /:53(?:[/?#]|$)/.test(url);
}
