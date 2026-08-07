import {
  CreateMeetingRequestSchema,
  CreateMeetingResponseSchema,
  KickParticipantRequestSchema,
  MeetingSummarySchema,
  ShareGrantRequestSchema
} from '@meeting/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config.js';
import type { HostApplicationService } from '../../services/host-application-service.js';
import type { MeetingService } from '../../services/meeting-service.js';
import { hostCookie, readSignedSessionCookie, setHostSessionCookie } from '../../security/session-token.js';
import { SessionAuthenticationError } from '../auth.js';
import { adminPasswordRateLimit, generalApiRateLimit } from '../rate-limit.js';

const SlugParamsSchema = Type.Object({ slug: Type.String({ minLength: 22, maxLength: 256 }) });

export function registerMeetingRoutes(app: FastifyInstance, dependencies: {
  config: AppConfig;
  meetings: MeetingService;
  hosts: HostApplicationService;
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

  app.get('/api/v1/meetings/:slug', {
    schema: { params: SlugParamsSchema, response: { 200: MeetingSummarySchema } },
    preHandler: app.rateLimit(generalApiRateLimit())
  }, async (request) => dependencies.meetings.getMeetingSummary(slug(request.params)));

  app.post('/api/v1/meetings/:slug/end', hostOptions(app), async (request, reply) => {
    const value = slug(request.params);
    await dependencies.hosts.endMeeting(hostSession(request, dependencies.hosts, value), value);
    return reply.status(204).send();
  });

  app.post('/api/v1/meetings/:slug/kick', {
    ...hostOptions(app), schema: { params: SlugParamsSchema, body: KickParticipantRequestSchema }
  }, async (request, reply) => {
    const value = slug(request.params);
    const body = request.body as { participantIdentity: string };
    await dependencies.hosts.kickParticipant(hostSession(request, dependencies.hosts, value), value, body.participantIdentity);
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
    await dependencies.hosts.revokeShare(hostSession(request, dependencies.hosts, value), value);
    return reply.status(204).send();
  });
}

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
