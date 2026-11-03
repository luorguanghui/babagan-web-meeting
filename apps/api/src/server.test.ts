import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startServer } from './server.js';

afterEach(() => vi.unstubAllEnvs());

it('starts the actual production composition with a trusted authenticated SFU gateway', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sfu-bootstrap-'));
  const env = {
    NODE_ENV: 'test', PUBLIC_BASE_URL: 'https://meet.example.test', LIVEKIT_URL: 'wss://rtc.example.test',
    LIVEKIT_INTERNAL_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'private',
    ADMIN_PASSWORD_HASH: 'unused-hash', COOKIE_SECRET: 'c'.repeat(32), DATABASE_PATH: join(directory, 'test.sqlite'),
    P2P_STUN_URLS: 'stun:stun.example.test:3478', P2P_TURN_URLS: 'turn:turn.example.test:3478',
    P2P_TURN_SECRET: 't'.repeat(32), P2P_TURN_TTL_SECONDS: '600', P2P_TURN_PROVIDER: 'coturn',
    CLOUDFLARE_SFU_APP_ID: '', CLOUDFLARE_SFU_APP_SECRET: '',
    CLOUDFLARE_SFU_GATEWAY_URL: 'https://p2p.babagan.cloud/api/sfu', CLOUDFLARE_SFU_GATEWAY_TOKEN: 'a'.repeat(64)
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ port: 0 });
    expect((await server.app.inject({ url: '/health/live' })).statusCode).toBe(200);
  } finally { await server?.shutdown(); rmSync(directory, { recursive: true, force: true }); }
});
