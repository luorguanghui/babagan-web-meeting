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
  ...overrides
});

describe('loadConfig', () => {
  it('requires PUBLIC_BASE_URL in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/PUBLIC_BASE_URL/);
  });

  it('rejects cookie secrets shorter than thirty-two characters', () => {
    expect(() => loadConfig(validEnv({ COOKIE_SECRET: 'short' }))).toThrow(/32/);
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
});
