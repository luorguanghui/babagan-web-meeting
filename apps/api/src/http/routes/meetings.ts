import {
  AdminEndMeetingRequestSchema,
  CreateMeetingRequestSchema,
  CreateMeetingResponseSchema,
  CurrentMeetingResponseSchema,
  KickParticipantRequestSchema,
  MeetingSummarySchema,
  ShareGrantRequestSchema
} from '@meeting/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config.js';
import type { P2pRoomRegistry } from '../../p2p/room-registry.js';
import type { HostApplicationService } from '../../services/host-application-service.js';
import type { MeetingService } from '../../services/meeting-service.js';
import type { ParticipantApplicationService } from '../../services/participant-application-service.js';
import { hostCookie, readSignedSessionCookie, setHostSessionCookie } from '../../security/session-token.js';
import { SessionAuthenticationError } from '../auth.js';
import { adminPasswordRateLimit, generalApiRateLimit } from '../rate-limit.js';

const SlugParamsSchema = Type.Object({ slug: Type.String({ minLength: 22, maxLength: 256 }) });

export function registerMeetingRoutes(app: FastifyInstance, dependencies: {
  config: AppConfig;
  meetings: MeetingService;
  hosts: HostApplicationService;
  participants: ParticipantApplicationService;
  p2p: P2pRoomRegistry;
}): void {
  app.post('/api/v1/meetings', {
    schema: { body: CreateMeetingRequestSchema, response: { 201: CreateMeetingResponseSchema } },
    preHandler: app.rateLimit(adminPasswordRateLimit())
  }, async (request, reply) => {
    const body = request.body as { adminPassword: string; name: string; meetingPassword?: string };
    const result = await dependencies.hosts.createMeeting(body);
    setHostSessionCookie(reply, result.rawHostToken);
    return reply.status(201).send({
      slug: result.meeting.slug,
      joinUrl: new URL(`/meetings/${result.meeting.slug}`, dependencies.config.publicBaseUrl).toString()
    });
  });

  app.get('/api/v1/meetings/current', {
    schema: { response: { 200: CurrentMeetingResponseSchema } },
    preHandler: app.rateLimit(generalApiRateLimit())
  }, async () => {
    const meeting = await dependencies.meetings.getCurrentMeetingSummary();
    return {
      meeting: meeting === null ? null : {
        ...meeting,
        joinUrl: new URL(`/meetings/${meeting.slug}`, dependencies.config.publicBaseUrl).toString()
      }
    };
  });

  app.get('/api/v1/meetings/:slug', {
    schema: { params: SlugParamsSchema, response: { 200: MeetingSummarySchema } },
    preHandler: app.rateLimit(generalApiRateLimit())
  }, async (request) => dependencies.meetings.getMeetingSummary(slug(request.params)));

  app.get('/api/v1/meetings/:slug/host-session', hostOptions(app), async (request, reply) => {
    const value = slug(request.params);
    hostSession(request, dependencies.hosts, value);
    return reply.status(204).send();
  });

  app.post('/api/v1/meetings/:slug/end', hostOptions(app), async (request, reply) => {
    const value = slug(request.params);
    await dependencies.hosts.endMeeting(hostSession(request, dependencies.hosts, value), value);
    dependencies.p2p.broadcastShareGone(value, 'meeting ended');
    return reply.status(204).send();
  });

  app.post('/api/v1/meetings/:slug/admin-end', {
    schema: { params: SlugParamsSchema, body: AdminEndMeetingRequestSchema },
    preHandler: app.rateLimit(adminPasswordRateLimit())
  }, async (request, reply) => {
    const body = request.body as { adminPassword: string };
    await dependencies.hosts.endMeetingWithAdminPassword(slug(request.params), body.adminPassword);
    dependencies.p2p.broadcastShareGone(slug(request.params), 'meeting ended');
    return reply.status(204).send();
  });

  app.post('/api/v1/meetings/:slug/kick', {
    ...hostOptions(app), schema: { params: SlugParamsSchema, body: KickParticipantRequestSchema }
  }, async (request, reply) => {
    const value = slug(request.params);
    const body = request.body as { participantIdentity: string };
    // The share lock is released inside kickParticipant; read the holder first
    // so `share-gone` is only announced when the kicked peer was the sharer.
    const wasSharer = dependencies.participants.getShareIdentity(value) === body.participantIdentity;
    await dependencies.hosts.kickParticipant(hostSession(request, dependencies.hosts, value), value, body.participantIdentity);
    if (wasSharer) dependencies.p2p.broadcastShareGone(value);
    return reply.status(204).send();
  });

  app.put('/api/v1/meetings/:slug/share-grant', {
    ...hostOptions(app), schema: { params: SlugParamsSchema, body: ShareGrantRequestSchema }
  }, async (request, reply) => {
    const value = slug(request.params);
    const body = request.body as { participantIdentity: string };
    await dependencies.hosts.grantShare(hostSession(request, dependencies.hosts, value), value, body.participantIdentity);
    return reply.status(204).send();
  });

  app.delete('/api/v1/meetings/:slug/share-grant', hostOptions(app), async (request, reply) => {
    const value = slug(request.params);
    // revokeShare is a no-op when no share is active; read the holder first so
    // `share-gone` is only announced when the lock is actually released.
    const wasSharing = dependencies.participants.getShareIdentity(value) !== null;
    await dependencies.hosts.revokeShare(hostSession(request, dependencies.hosts, value), value);
    if (wasSharing) dependencies.p2p.broadcastShareGone(value);
    return reply.status(204).send();
  });
}

/**
 * Note on `broadcastShareGone` coverage: all explicit HTTP release paths
 * (revoke, end, sharer self-release, sharer leave, kick) announce `share-gone`.
 * The background cleanup task (empty/expired meetings) is not wired to the
 * in-memory registry; those connections die with the socket eventually.
 */

function hostOptions(app: FastifyInstance) {
  return {
    schema: { params: SlugParamsSchema },
    preHandler: app.rateLimit(generalApiRateLimit())
  };
}

function hostSession(
  request: FastifyRequest,
  hosts: HostApplicationService,
  slugValue: string
) {
  const raw = readSignedSessionCookie(request, hostCookie);
  if (!raw) throw new SessionAuthenticationError();
  return hosts.authenticate(raw, slugValue);
}

function slug(params: unknown): string {
  return (params as { slug: string }).slug;
}
