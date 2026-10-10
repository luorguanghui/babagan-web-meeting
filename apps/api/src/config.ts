import type { P2pTurnProvider } from '@meeting/contracts';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  publicBaseUrl: URL;
  livekitUrl: URL;
  livekitInternalUrl: URL;
  livekitApiKey: string;
  livekitApiSecret: string;
  adminPasswordHash: string;
  cookieSecret: string;
  databasePath: string;
  p2pStunUrls: string[];
  p2pTurnUrls: string[];
  p2pTurnSecret: string;
  p2pTurnTtlSeconds: number;
  p2pTurnProvider?: P2pTurnProvider;
  cloudflareSfuAppId?: string;
  cloudflareSfuAppSecret?: string;
  meetingTtlMs: 86_400_000;
  emptyGraceMs: 600_000;
  reconnectGraceMs: 30_000;
  reservationTtlMs: 60_000;
  maxParticipants: 5;
}

type Environment = Record<string, string | undefined>;

function requireValue(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseUrl(env: Environment, name: string, protocols: readonly string[]): URL {
  const value = requireValue(env, name);
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}`);
  }

  return url;
}

function parseStunUrls(env: Environment): string[] {
  const urls = requireValue(env, 'P2P_STUN_URLS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (urls.length === 0 || urls.some((value) => !/^stuns?:/i.test(value))) {
    throw new Error('P2P_STUN_URLS must contain only stun: or stuns: URLs');
  }
  return urls;
}

function parseTurnUrls(env: Environment): string[] {
  const urls = requireValue(env, 'P2P_TURN_URLS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (urls.length === 0 || urls.some((value) => !/^turns?:/i.test(value))) {
    throw new Error('P2P_TURN_URLS must contain only turn: or turns: URLs');
  }
  return urls;
}

function parseTurnTtlSeconds(env: Environment): number {
  const raw = requireValue(env, 'P2P_TURN_TTL_SECONDS');
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error('P2P_TURN_TTL_SECONDS must be an integer');
  if (value < 60 || value > 3_600) {
    throw new Error('P2P_TURN_TTL_SECONDS must be between 60 and 3600');
  }
  return value;
}

function parseTurnProvider(env: Environment): P2pTurnProvider {
  const value = env.P2P_TURN_PROVIDER?.trim() || 'coturn';
  if (value !== 'coturn') throw new Error('P2P_TURN_PROVIDER must be coturn');
  return value;
}

function parseCloudflareSfu(env: Environment) {
  const cloudflareSfuAppId = env.CLOUDFLARE_SFU_APP_ID?.trim() || undefined;
  const cloudflareSfuAppSecret = env.CLOUDFLARE_SFU_APP_SECRET?.trim() || undefined;
  if (!!cloudflareSfuAppId !== !!cloudflareSfuAppSecret) throw new Error('CLOUDFLARE_SFU_APP_ID and CLOUDFLARE_SFU_APP_SECRET must both be set or both be empty');
  if (cloudflareSfuAppId && !/^[A-Za-z0-9_-]+$/.test(cloudflareSfuAppId)) throw new Error('CLOUDFLARE_SFU_APP_ID must be an identifier');
  return { cloudflareSfuAppId, cloudflareSfuAppSecret };
}
export function loadConfig(env: Environment): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const publicBaseUrl = parseUrl(env, 'PUBLIC_BASE_URL', ['http:', 'https:']);
  if (nodeEnv === 'production' && publicBaseUrl.protocol !== 'https:') {
    throw new Error('PUBLIC_BASE_URL must use https in production');
  }

  const cookieSecret = requireValue(env, 'COOKIE_SECRET');
  if (Buffer.byteLength(cookieSecret, 'utf8') < 32) {
    throw new Error('COOKIE_SECRET must be at least 32 bytes');
  }

  const p2pTurnSecret = requireValue(env, 'P2P_TURN_SECRET');
  if (Buffer.byteLength(p2pTurnSecret, 'utf8') < 32) {
    throw new Error('P2P_TURN_SECRET must be at least 32 bytes');
  }

  const p2pTurnProvider = parseTurnProvider(env);
  return {
    nodeEnv,
    publicBaseUrl,
    livekitUrl: parseUrl(env, 'LIVEKIT_URL', ['wss:']),
    livekitInternalUrl: parseUrl(env, 'LIVEKIT_INTERNAL_URL', ['ws:', 'wss:']),
    livekitApiKey: requireValue(env, 'LIVEKIT_API_KEY'),
    livekitApiSecret: requireValue(env, 'LIVEKIT_API_SECRET'),
    adminPasswordHash: requireValue(env, 'ADMIN_PASSWORD_HASH'),
    cookieSecret,
    databasePath: requireValue(env, 'DATABASE_PATH'),
    p2pStunUrls: parseStunUrls(env),
    p2pTurnUrls: parseTurnUrls(env),
    p2pTurnSecret,
    p2pTurnTtlSeconds: parseTurnTtlSeconds(env),
    p2pTurnProvider,
    ...parseCloudflareSfu(env),
    meetingTtlMs: 86_400_000,
    emptyGraceMs: 600_000,
    reconnectGraceMs: 30_000,
    reservationTtlMs: 60_000,
    maxParticipants: 5
  };
}
