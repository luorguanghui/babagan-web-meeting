import {
  JoinMeetingRequestSchema,
  JoinMeetingResponseSchema,
  ParticipantsResponseSchema,
  RefreshParticipantTokenResponseSchema
} from '@meeting/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { P2pRoomRegistry } from '../../p2p/room-registry.js';
import type { MeetingService } from '../../services/meeting-service.js';
import type { HostApplicationService } from '../../services/host-application-service.js';
import type { ParticipantApplicationService } from '../../services/participant-application-service.js';
import {
  participantCookie,
  readSignedSessionCookie,
  setParticipantSessionCookie
} from '../../security/session-token.js';
import { SessionAuthenticationError } from '../auth.js';
import { generalApiRateLimit, meetingPasswordRateLimit } from '../rate-limit.js';

const SlugParamsSchema = Type.Object({ slug: Type.String({ minLength: 22, maxLength: 256 }) });
export function registerParticipantRoutes(app: FastifyInstance, dependencies: {
  meetings: MeetingService;
  hosts: HostApplicationService;
  participants: ParticipantApplicationService;
  p2p: P2pRoomRegistry;
}): void {
  app.post('/api/v1/meetings/:slug/join', {
    schema: { params: SlugParamsSchema, body: JoinMeetingRequestSchema, response: { 200: JoinMeetingResponseSchema } },
    preHandler: app.rateLimit(meetingPasswordRateLimit())
  }, async (request, reply) => {
    const result = await dependencies.meetings.joinMeeting(slug(request.params), request.body as {
      nickname: string; meetingPassword?: string;
    });
    setParticipantSessionCookie(reply, result.participantSessionToken);
    return {
      participantIdentity: result.participantIdentity,
      participantName: result.participantName,
      livekitUrl: result.livekitUrl,
      token: result.token,
      meetingExpiresAt: result.meetingExpiresAt,
      permissions: result.permissions
    };
  });

  app.post('/api/v1/meetings/:slug/token', {
    schema: { params: SlugParamsSchema, response: { 200: RefreshParticipantTokenResponseSchema } },
    preHandler: app.rateLimit(generalApiRateLimit())
  }, async (request) => {
    const value = slug(request.params);
    return dependencies.participants.refreshToken(session(request, dependencies.participants, value), value);
  });

  app.post('/api/v1/meetings/:slug/leave', participantOptions(app), async (request, reply) => {
    const value = slug(request.params);
    const participant = leaveSession(request, dependencies.participants, value);
    // leaveMeeting releases the share lock only when the leaver is the sharer;
    // read the holder first so `share-gone` is only announced in that case.
    const wasSharer = dependencies.participants.getShareIdentity(value) === participant.identity;
    await dependencies.meetings.leaveMeeting(value, participant.identity);
    if (wasSharer) dependencies.p2p.broadcastShareGone(value);
    return reply.status(204).send();
  });

  app.delete('/api/v1/meetings/:slug/share', participantOptions(app), async (request, reply) => {
    const value = slug(request.params);
    const active = session(request, dependencies.participants, value);
    await dependencies.hosts.releaseParticipantShare(value, active.identity);
    dependencies.p2p.broadcastShareGone(value);
    return reply.status(204).send();
  });

  app.get('/api/v1/meetings/:slug/participants', {
    schema: { params: SlugParamsSchema, response: { 200: ParticipantsResponseSchema } },
    preHandler: app.rateLimit(generalApiRateLimit())
  }, async (request) => {
    const value = slug(request.params);
    return dependencies.participants.listParticipants(session(request, dependencies.participants, value), value);
  });
}

function participantOptions(app: FastifyInstance) {
  return { schema: { params: SlugParamsSchema }, preHandler: app.rateLimit(generalApiRateLimit()) };
}

function session(request: FastifyRequest, participants: ParticipantApplicationService, slugValue: string) {
  const raw = readSignedSessionCookie(request, participantCookie);
  if (!raw) throw new SessionAuthenticationError();
  return participants.authenticate(raw, slugValue);
}

function leaveSession(request: FastifyRequest, participants: ParticipantApplicationService, slugValue: string) {
  const raw = readSignedSessionCookie(request, participantCookie);
  if (!raw) throw new SessionAuthenticationError();
  return participants.authenticateForLeave(raw, slugValue);
}

function slug(params: unknown): string { return (params as { slug: string }).slug; }
