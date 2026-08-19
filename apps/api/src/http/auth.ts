import type {} from '@fastify/cookie';
import type { FastifyRequest } from 'fastify';

import type { HostSession, ParticipantSession } from '../repositories/models.js';
import { hashSessionToken, hostCookie, participantCookie, readSignedSessionCookie } from '../security/session-token.js';

export interface SessionRepository {
  findHostSessionByTokenHash(tokenHash: string, now: number): HostSession | null;
  findParticipantSessionByTokenHash(tokenHash: string, now: number): ParticipantSession | null;
}

export class SessionAuthenticationError extends Error {
  readonly statusCode = 401;

  constructor() {
    super('Unauthorized session');
    this.name = 'SessionAuthenticationError';
  }
}

export function requireHostSession(
  request: FastifyRequest,
  repository: SessionRepository,
  now: number,
  meetingId: string
): HostSession {
  const token = requireSignedToken(request, hostCookie);
  const session = repository.findHostSessionByTokenHash(hashSessionToken(token), now);
  if (!session || session.meetingId !== meetingId) throw new SessionAuthenticationError();
  return session;
}

export function requireParticipantSession(
  request: FastifyRequest,
  repository: SessionRepository,
  now: number,
  meetingId: string
): ParticipantSession {
  const token = requireSignedToken(request, participantCookie);
  const session = repository.findParticipantSessionByTokenHash(hashSessionToken(token), now);
  if (!session || session.meetingId !== meetingId) throw new SessionAuthenticationError();
  return session;
}

function requireSignedToken(request: FastifyRequest, cookieName: string): string {
  const token = readSignedSessionCookie(request, cookieName);
  if (!token) throw new SessionAuthenticationError();
  return token;
}
