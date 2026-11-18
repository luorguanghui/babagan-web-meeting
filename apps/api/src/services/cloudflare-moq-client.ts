import { randomUUID } from 'node:crypto';

const CONNECTION_ORIGIN = 'https://draft-18.cloudflare.mediaoverquic.com';
const REQUEST_TIMEOUT_MS = 3_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_TOKEN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,3999}$/;

export interface MoqConnectionToken {
  jti: string;
  url: string;
  expiresAt: number;
}

export interface CloudflareMoqApi {
  createRelay(name: string): Promise<string>;
  findRelay(name: string, createdAfter: number): Promise<string | undefined>;
  deleteRelay(relayId: string): Promise<void>;
  createToken(relayId: string, role: 'publisher' | 'viewer', expiresAt: number): Promise<MoqConnectionToken>;
  deleteToken(relayId: string, jti: string): Promise<void>;
}

export class CloudflareMoqRequestError extends Error {
  constructor(readonly definitivelyRejected = false) {
    super('Cloudflare MoQ management request failed');
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

export class CloudflareMoqClient implements CloudflareMoqApi {
  private readonly relaysUrl: string;

  constructor(private readonly options: { accountId: string; apiToken: string; fetch?: typeof fetch }) {
    this.relaysUrl = 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(options.accountId) + '/moq/relays';
  }

  async createRelay(name: string): Promise<string> {
    const result = object(await this.request('POST', '', { name }));
    if (!safeId(result?.uid)) throw new CloudflareMoqRequestError();
    return result.uid;
  }

  async findRelay(name: string, createdAfter: number): Promise<string | undefined> {
    const query = new URLSearchParams({ created_after: new Date(createdAfter).toISOString(), asc: 'true', per_page: '1000' });
    const result = await this.request('GET', '?' + query.toString());
    if (!Array.isArray(result)) throw new CloudflareMoqRequestError();
    const entry = result.map(object).find((relay) => relay?.name === name);
    if (entry && !safeId(entry.uid)) throw new CloudflareMoqRequestError();
    return typeof entry?.uid === 'string' ? entry.uid : undefined;
  }

  async deleteRelay(relayId: string): Promise<void> {
    await this.request('DELETE', '/' + relayId);
  }

  async createToken(relayId: string, role: 'publisher' | 'viewer', expiresAt: number): Promise<MoqConnectionToken> {
    const operations = role === 'publisher' ? ['publish', 'subscribe'] : ['subscribe'];
    const label = role + '-' + randomUUID();
    const result = object(await this.request('POST', '/' + relayId + '/tokens', {
      label, operations, expires: new Date(expiresAt).toISOString()
    }));
    const issuers = result?.issuers;
    const issuer = Array.isArray(issuers) && issuers.map(object).find((value) => value?.type === 'cloudflare_jwt');
    const tokens = issuer ? issuer.cloudflare_tokens : undefined;
    const token = Array.isArray(tokens) && tokens.map(object).find((value) => value?.label === label);
    if (!token || !safeId(token.jti) || typeof token.secret !== 'string' || !SAFE_TOKEN.test(token.secret)
      || !Array.isArray(token.operations) || token.operations.length !== operations.length
      || !operations.every((operation) => (token.operations as unknown[]).includes(operation))) {
      throw new CloudflareMoqRequestError();
    }
    const expiration = typeof token.expires === 'string' ? Date.parse(token.expires) : NaN;
    if (!Number.isFinite(expiration) || expiration > expiresAt) throw new CloudflareMoqRequestError();
    return { jti: token.jti, url: CONNECTION_ORIGIN + '/' + token.secret, expiresAt: expiration };
  }

  async deleteToken(relayId: string, jti: string): Promise<void> {
    await this.request('DELETE', '/' + relayId + '/tokens/' + jti);
  }

  private async request(method: 'POST' | 'GET' | 'DELETE', path: string, body?: object): Promise<unknown> {
    try {
      const response = await (this.options.fetch ?? fetch)(this.relaysUrl + path, {
        method,
        redirect: 'error',
        headers: {
          Authorization: 'Bearer ' + this.options.apiToken,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (method === 'DELETE' && [204, 404].includes(response.status)) return;
      if (!response.ok) throw new CloudflareMoqRequestError(response.status >= 400 && response.status < 500 && response.status !== 408);
      const envelope = object(await response.json());
      if (envelope?.success !== true) throw new CloudflareMoqRequestError();
      return envelope.result;
    } catch (error) {
      // Upstream error messages and response bodies can include connection credentials.
      if (error instanceof CloudflareMoqRequestError) throw error;
      throw new CloudflareMoqRequestError();
    }
  }
}
