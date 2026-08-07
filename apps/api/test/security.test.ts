import cookie from '@fastify/cookie';
import argon2 from 'argon2';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { authenticateMeetingPassword, Argon2PasswordHasher } from '../src/security/password-hasher.js';
import {
  hashSessionToken,
  hostCookie,
  participantCookie,
  setHostSessionCookie,
  setParticipantSessionCookie
} from '../src/security/session-token.js';
import {
  requireHostSession,
  requireParticipantSession
} from '../src/http/auth.js';
import { registerStrictOriginValidation } from '../src/http/origin.js';
import {
  adminPasswordRateLimit,
  generalApiRateLimit,
  meetingPasswordRateLimit
} from '../src/http/rate-limit.js';

describe('password hashing', () => {
  it('hashes and verifies passwords with Argon2id', async () => {
    const passwords = new Argon2PasswordHasher();
    const hash = await passwords.hash('correct horse battery staple');

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(passwords.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(passwords.verify(hash, 'wrong')).resolves.toBe(false);
  });

  it('returns one public error for missing and incorrect meeting passwords', async () => {
    const passwords = new Argon2PasswordHasher();
    const hash = await passwords.hash('correct');
    const emptyPasswordHash = await passwords.hash('');

    await expect(authenticateMeetingPassword(passwords, emptyPasswordHash, undefined))
      .rejects.toMatchObject({ code: 'INVALID_MEETING_PASSWORD' });
    await expect(authenticateMeetingPassword(passwords, emptyPasswordHash, ''))
      .rejects.toMatchObject({ code: 'INVALID_MEETING_PASSWORD' });
    await expect(authenticateMeetingPassword(passwords, hash, undefined))
      .rejects.toMatchObject({ code: 'INVALID_MEETING_PASSWORD' });
    await expect(authenticateMeetingPassword(passwords, hash, ''))
      .rejects.toMatchObject({ code: 'INVALID_MEETING_PASSWORD' });
    await expect(authenticateMeetingPassword(passwords, hash, 'correct')).resolves.toBeUndefined();
    await expect(authenticateMeetingPassword(passwords, hash, 'wrong'))
      .rejects.toMatchObject({ code: 'INVALID_MEETING_PASSWORD' });
  });

  it('rejects Argon2i and Argon2d hashes even when their password is correct', async () => {
    const passwords = new Argon2PasswordHasher();
    const argon2iHash = await argon2.hash('correct', { type: argon2.argon2i });
    const argon2dHash = await argon2.hash('correct', { type: argon2.argon2d });

    await expect(passwords.verify(argon2iHash, 'correct')).resolves.toBe(false);
    await expect(passwords.verify(argon2dHash, 'correct')).resolves.toBe(false);
  });

  it('uses 64 MiB per Argon2id verification, or 320 MiB for five concurrent attempts', () => {
    // This upper bound fits comfortably within the 2 GiB API host budget.
    expect(Argon2PasswordHasher.memoryCostKiB).toBe(65_536);
    console.info(`Argon2id memory cost: ${Argon2PasswordHasher.memoryCostKiB} KiB per verification; ${Argon2PasswordHasher.memoryCostKiB * 5 / 1024} MiB for five concurrent attempts.`);
  });
});

describe('session tokens and cookies', () => {
  it('stores only a SHA-256 hash of the raw session token', () => {
    const raw = 'session-token-not-stored';
    const hash = hashSessionToken(raw);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(raw);
  });

  it('sets signed strict host and participant cookies at the root path', async () => {
    const app = Fastify();
    await app.register(cookie, { secret: 'a'.repeat(32) });
    const sessions = new FakeSessionRepository();
    app.get('/host', async (_request, reply) => {
      setHostSessionCookie(reply, 'host-session');
      return { ok: true };
    });
    app.get('/participant', async (_request, reply) => {
      setParticipantSessionCookie(reply, 'participant-session');
      return { ok: true };
    });
    app.get('/host/authorized', async (request) => {
      requireHostSession(request, sessions, 1_000, 'meeting-1');
      return { ok: true };
    });
    app.get('/participant/authorized', async (request) => {
      requireParticipantSession(request, sessions, 1_000, 'meeting-1');
      return { ok: true };
    });

    const host = await app.inject('/host');
    const participant = await app.inject('/participant');

    expect(host.headers['set-cookie']).toMatch(new RegExp(`^${hostCookie}=`));
    expect(host.headers['set-cookie']).toContain('HttpOnly');
    expect(host.headers['set-cookie']).toContain('Secure');
    expect(host.headers['set-cookie']).toContain('SameSite=Strict');
    expect(host.headers['set-cookie']).toContain('Path=/');
    expect(participant.headers['set-cookie']).toMatch(new RegExp(`^${participantCookie}=`));
    expect(participant.headers['set-cookie']).toContain('HttpOnly');
    expect(participant.headers['set-cookie']).toContain('Secure');
    expect(participant.headers['set-cookie']).toContain('SameSite=Strict');
    expect(participant.headers['set-cookie']).toContain('Path=/');
    expect((await app.inject({
      url: '/host/authorized', headers: { cookie: cookiePair(host.headers['set-cookie']) }
    })).statusCode).toBe(200);
    expect((await app.inject({
      url: '/participant/authorized', headers: { cookie: cookiePair(participant.headers['set-cookie']) }
    })).statusCode).toBe(200);

    await app.close();
  });

  it('rejects a tampered signed session cookie', async () => {
    const app = Fastify();
    await app.register(cookie, { secret: 'a'.repeat(32) });
    app.get('/protected', async (request) => {
      await requireHostSession(request, new FakeSessionRepository(), 1_000, 'meeting-1');
      return { ok: true };
    });

    const signed = app.signCookie('host-session');
    const response = await app.inject({
      url: '/protected',
      headers: { cookie: `${hostCookie}=${signed}tampered` }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ message: 'Unauthorized session' });
    await app.close();
  });

  it('does not let host or participant sessions cross meeting scope', async () => {
    const app = Fastify();
    await app.register(cookie, { secret: 'a'.repeat(32) });
    const repo = new FakeSessionRepository();
    app.get('/host', async (request) => requireHostSession(request, repo, 1_000, 'meeting-2'));
    app.get('/participant', async (request) => requireParticipantSession(request, repo, 1_000, 'meeting-2'));

    const hostResponse = await app.inject({
      url: '/host', headers: { cookie: `${hostCookie}=${app.signCookie('host-session')}` }
    });
    const participantResponse = await app.inject({
      url: '/participant', headers: { cookie: `${participantCookie}=${app.signCookie('participant-session')}` }
    });

    expect(hostResponse.statusCode).toBe(401);
    expect(participantResponse.statusCode).toBe(401);
    await app.close();
  });
});

describe('request protection middleware', () => {
  it('rejects missing or foreign Origins for every modifying request', async () => {
    const app = Fastify();
    registerStrictOriginValidation(app, new URL('https://meet.example.test'));
    app.post('/modify', async () => ({ ok: true }));

    await expect(app.inject({ method: 'POST', url: '/modify' })).resolves.toMatchObject({ statusCode: 403 });
    await expect(app.inject({
      method: 'POST', url: '/modify', headers: { origin: 'https://attacker.example' }
    })).resolves.toMatchObject({ statusCode: 403 });
    await expect(app.inject({
      method: 'POST', url: '/modify', headers: { origin: 'https://meet.example.test' }
    })).resolves.toMatchObject({ statusCode: 200 });
    await app.close();
  });

  it('uses separate admin, meeting, and general rate-limit buckets without revealing resource state', async () => {
    const app = Fastify();
    await app.register((await import('@fastify/rate-limit')).default, { global: false });
    app.post('/admin', { preHandler: app.rateLimit(adminPasswordRateLimit({ max: 1, timeWindow: 60_000 })) }, async () => ({ ok: true }));
    app.post('/meetings/:slug/join', { preHandler: app.rateLimit(meetingPasswordRateLimit({ max: 1, timeWindow: 60_000 })) }, async () => ({ ok: true }));
    app.get('/status', { preHandler: app.rateLimit(generalApiRateLimit({ max: 1, timeWindow: 60_000 })) }, async () => ({ ok: true }));

    expect((await app.inject({ method: 'POST', url: '/admin' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/meetings/one/join' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/status' })).statusCode).toBe(200);
    const limited = await app.inject({ method: 'POST', url: '/meetings/one/join' });

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ message: 'RATE_LIMITED' });
    expect((await app.inject({ method: 'POST', url: '/meetings/two/join' })).statusCode).toBe(200);
    await app.close();
  });
});

class FakeSessionRepository {
  findHostSessionByTokenHash(tokenHash: string, now: number) {
    return tokenHash === hashSessionToken('host-session') && now === 1_000
      ? { id: 'host-1', meetingId: 'meeting-1', tokenHash, createdAt: 0, expiresAt: 2_000, revokedAt: null }
      : null;
  }

  findParticipantSessionByTokenHash(tokenHash: string, now: number) {
    return tokenHash === hashSessionToken('participant-session') && now === 1_000
      ? { identity: 'participant-1', meetingId: 'meeting-1', nickname: 'Ada', tokenHash, expiresAt: 2_000, revokedAt: null }
      : null;
  }
}

function cookiePair(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) throw new Error('Expected Set-Cookie header');
  return value.split(';', 1)[0];
}
