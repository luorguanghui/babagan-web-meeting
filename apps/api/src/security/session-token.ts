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

export function setHostSessionCookie(reply: FastifyReply, rawToken: string): FastifyReply {
  return reply.setCookie(hostCookie, rawToken, sessionCookieOptions);
}

export function setParticipantSessionCookie(reply: FastifyReply, rawToken: string): FastifyReply {
  return reply.setCookie(participantCookie, rawToken, sessionCookieOptions);
}

export function readSignedSessionCookie(request: SignedCookieRequest, cookieName: string): string | null {
  const rawCookie = request.cookies[cookieName];
  if (!rawCookie) return null;

  const unsigned = request.unsignCookie(rawCookie);
  return unsigned.valid ? unsigned.value : null;
}
