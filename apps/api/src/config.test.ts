import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const validEnv = (overrides: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'https://meet.example.test',
  LIVEKIT_URL: 'wss://rtc.example.test',
  LIVEKIT_INTERNAL_URL: 'ws://livekit:7880',
  LIVEKIT_API_KEY: 'development-api-key',
  LIVEKIT_API_SECRET: 'development-api-secret',
  ADMIN_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$salt$hash',
  COOKIE_SECRET: 'a-very-long-development-cookie-secret',
  DATABASE_PATH: './data/meetings.sqlite',
  P2P_STUN_URLS: 'stun:stun1.example.test:3478',
  P2P_TURN_URLS: 'turn:turn.example.test:3478?transport=udp,turns:turn.example.test:5349?transport=tcp',
  P2P_TURN_SECRET: '0123456789abcdef0123456789abcdef',
  P2P_TURN_TTL_SECONDS: '600',
  ...overrides
});

describe('loadConfig', () => {
  it('requires PUBLIC_BASE_URL in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/PUBLIC_BASE_URL/);
  });

  it('rejects cookie secrets shorter than thirty-two characters', () => {
    expect(() => loadConfig(validEnv({ COOKIE_SECRET: 'short' }))).toThrow(/32/);
  });

  it('counts cookie-secret length in UTF-8 bytes rather than Unicode code points', () => {
    expect(() => loadConfig(validEnv({ COOKIE_SECRET: '🔐'.repeat(8) }))).not.toThrow();
  });

  it('rejects a non-WSS public LiveKit URL', () => {
    expect(() => loadConfig(validEnv({ LIVEKIT_URL: 'ws://rtc.example.test' }))).toThrow(/wss/i);
  });

  it('uses the fixed meeting limits', () => {
    const config = loadConfig(validEnv({
      MAX_PARTICIPANTS: '99',
      MEETING_TTL_SECONDS: '1',
      EMPTY_GRACE_SECONDS: '1',
      RECONNECT_GRACE_SECONDS: '1'
    }));

    expect(config.maxParticipants).toBe(5);
    expect(config.meetingTtlMs).toBe(86_400_000);
    expect(config.emptyGraceMs).toBe(600_000);
    expect(config.reconnectGraceMs).toBe(30_000);
    expect(config.reservationTtlMs).toBe(60_000);
  });

  it('does not supply production credential defaults', () => {
    expect(() => loadConfig({
      ...validEnv(),
      NODE_ENV: 'production',
      LIVEKIT_API_SECRET: undefined
    })).toThrow(/LIVEKIT_API_SECRET/);
  });

  it('parses configured STUN URLs and rejects non-STUN protocols', () => {
    expect(loadConfig(validEnv({
      P2P_STUN_URLS: ' stun:stun1.example.test:3478,stuns:stun2.example.test:5349 '
    })).p2pStunUrls).toEqual([
      'stun:stun1.example.test:3478',
      'stuns:stun2.example.test:5349'
    ]);

    expect(() => loadConfig(validEnv({ P2P_STUN_URLS: 'turn:relay.example.test:3478' })))
      .toThrow('P2P_STUN_URLS must contain only stun: or stuns: URLs');
  });

  it('parses TURN URLs, secret and credential lifetime', () => {
    const config = loadConfig(validEnv());
    expect(config.p2pTurnUrls).toEqual([
      'turn:turn.example.test:3478?transport=udp',
      'turns:turn.example.test:5349?transport=tcp'
    ]);
    expect(config.p2pTurnSecret).toBe('0123456789abcdef0123456789abcdef');
    expect(config.p2pTurnTtlSeconds).toBe(600);
  });

  it('loads Cloudflare TURN provider credentials without exposing them to the client config', () => {
    const config = loadConfig(validEnv({
      P2P_TURN_PROVIDER: 'cloudflare',
      CLOUDFLARE_TURN_KEY_ID: 'turn-key-id',
      CLOUDFLARE_TURN_API_TOKEN: 'turn-api-token',
      CLOUDFLARE_TURN_TTL_SECONDS: '600'
    })) as ReturnType<typeof loadConfig> & {
      p2pTurnProvider?: string;
      cloudflareTurnKeyId?: string;
      cloudflareTurnApiToken?: string;
      cloudflareTurnTtlSeconds?: number;
    };

    expect(config.p2pTurnProvider).toBe('cloudflare');
    expect(config.cloudflareTurnKeyId).toBe('turn-key-id');
    expect(config.cloudflareTurnApiToken).toBe('turn-api-token');
    expect(config.cloudflareTurnTtlSeconds).toBe(600);
  });

  it('ignores Cloudflare-only settings while coturn remains the active provider', () => {
    expect(loadConfig(validEnv({ CLOUDFLARE_TURN_TTL_SECONDS: 'not-used' }))).toMatchObject({
      p2pTurnProvider: 'coturn',
      cloudflareTurnTtlSeconds: undefined
    });
  });

  it('rejects unsafe TURN configuration', () => {
    expect(() => loadConfig(validEnv({ P2P_TURN_URLS: 'stun:turn.example.test:3478' })))
      .toThrow('P2P_TURN_URLS must contain only turn: or turns: URLs');
    expect(() => loadConfig(validEnv({ P2P_TURN_SECRET: 'short' }))).toThrow(/32/);
    expect(() => loadConfig(validEnv({ P2P_TURN_TTL_SECONDS: '59' }))).toThrow(/60/);
    expect(() => loadConfig(validEnv({ P2P_TURN_TTL_SECONDS: '3601' }))).toThrow(/3600/);
    expect(() => loadConfig(validEnv({ P2P_TURN_TTL_SECONDS: '600.5' }))).toThrow(/integer/);
  });
});
