import { createHash } from 'node:crypto';

import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const hostCookie = 'wm_host';
export const participantCookie = 'wm_participant';

const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
  path: '/',
  signed: true
};

type SignedCookieRequest = Pick<FastifyRequest, 'cookies' | 'unsignCookie'>;

export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export type SessionCookieKind = typeof hostCookie | typeof participantCookie;

/** Hashing a slug gives a bounded cookie-safe name, including for invalid input. */
export function meetingSessionCookieName(kind: SessionCookieKind, slug: string): string {
  return `__Host-${kind}_${createHash('sha256').update(slug, 'utf8').digest('hex').slice(0, 32)}`;
}

export function setHostSessionCookie(reply: FastifyReply, rawToken: string, slug: string, expiresAt: number): FastifyReply {
  return reply.setCookie(meetingSessionCookieName(hostCookie, slug), rawToken, { ...sessionCookieOptions, expires: new Date(expiresAt) });
}

export function setParticipantSessionCookie(reply: FastifyReply, rawToken: string, slug: string, expiresAt: number): FastifyReply {
  return reply.setCookie(meetingSessionCookieName(participantCookie, slug), rawToken, { ...sessionCookieOptions, expires: new Date(expiresAt) });
}

export function clearMeetingSessionCookie(reply: FastifyReply, kind: SessionCookieKind, slug: string): void {
  reply.clearCookie(meetingSessionCookieName(kind, slug), sessionCookieOptions);
}

export function readMeetingSessionCookie(request: SignedCookieRequest, kind: SessionCookieKind, slug: string): string | null {
  const scoped = meetingSessionCookieName(kind, slug);
  // A present but invalid scoped credential must fail closed. Legacy fallback
  // only supports sessions created before migration, and callers still verify
  // that the credential's database meeting ID matches the requested slug.
  return readSignedSessionCookie(request, request.cookies[scoped] === undefined ? kind : scoped);
}

export function readSignedSessionCookie(request: SignedCookieRequest, cookieName: string): string | null {
  const rawCookie = request.cookies[cookieName];
  if (!rawCookie) return null;

  const unsigned = request.unsignCookie(rawCookie);
  return unsigned.valid ? unsigned.value : null;
}
