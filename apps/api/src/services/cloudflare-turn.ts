import { request as httpsRequest } from 'node:https';

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

export interface CloudflareTurnHttpRequest {
  url: URL;
  connectIp?: string;
  headers: Record<string, string>;
  body: string;
}

export interface CloudflareTurnHttpResponse {
  status: number;
  json(): Promise<unknown>;
}

type CloudflareTurnRequest = (
  request: CloudflareTurnHttpRequest
) => Promise<CloudflareTurnHttpResponse>;

export async function fetchCloudflareTurnIceServers(input: {
  keyId: string;
  apiToken: string;
  ttlSeconds: number;
  connectIps?: readonly string[];
  requestImpl?: CloudflareTurnRequest;
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}): Promise<TurnIceServerConfiguration> {
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(input.keyId)}/credentials/generate-ice-servers`;
  const requestUrl = new URL(url);
  const body = JSON.stringify({ ttl: input.ttlSeconds });
  const headers = {
    authorization: `Bearer ${input.apiToken}`,
    'content-type': 'application/json'
  };
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = input.connectIps?.length
    ? await requestWithConnectIps(
      input.requestImpl ?? requestOverPinnedHttps,
      { url: requestUrl, headers, body },
      input.connectIps
    )
    : input.requestImpl
      ? await input.requestImpl({ url: requestUrl, headers, body })
      : await fetchImpl(url, {
        method: 'POST',
        headers,
        body
      });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Cloudflare TURN credentials request failed with ${response.status}`);
  }

  const payload = await response.json() as CloudflareIceServersResponse;
  const iceServers = normalizeCloudflareIceServers(payload.iceServers);
  const nowSeconds = input.nowSeconds ?? (() => Date.now() / 1_000);
  return {
    iceServers,
    turnProvider: 'cloudflare',
    turnCredentialsExpiresAt: Math.floor(nowSeconds()) + input.ttlSeconds
  };
}

async function requestWithConnectIps(
  requestImpl: CloudflareTurnRequest,
  request: Omit<CloudflareTurnHttpRequest, 'connectIp'>,
  connectIps: readonly string[]
): Promise<CloudflareTurnHttpResponse> {
  let lastError: unknown;
  for (const connectIp of connectIps) {
    try {
      return await requestImpl({
        ...request,
        connectIp,
        headers: { ...request.headers, host: request.url.hostname }
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Cloudflare TURN credentials request failed for all connect IPs');
}

function requestOverPinnedHttps(input: CloudflareTurnHttpRequest): Promise<CloudflareTurnHttpResponse> {
  if (!input.connectIp) throw new Error('Cloudflare TURN connect IP is required');
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: input.connectIp,
      port: 443,
      method: 'POST',
      path: `${input.url.pathname}${input.url.search}`,
      servername: input.url.hostname,
      headers: {
        ...input.headers,
        host: input.url.hostname,
        'content-length': String(Buffer.byteLength(input.body))
      },
      timeout: 10_000
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode ?? 0,
          json: async () => JSON.parse(body) as unknown
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error('Cloudflare TURN credentials request timed out')));
    request.on('error', reject);
    request.end(input.body);
  });
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
