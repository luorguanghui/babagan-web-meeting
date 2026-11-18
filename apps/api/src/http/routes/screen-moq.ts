import {
  ScreenMoqConnectionResponseSchema,
  ScreenMoqStatusResponseSchema,
  ScreenMoqSubscribeRequestSchema,
  type ScreenMoqSubscribeRequest
} from '@meeting/contracts';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { domainError } from '../../domain/errors.js';
import { participantCookie, readMeetingSessionCookie } from '../../security/session-token.js';
import type { CloudflareMoqService } from '../../services/cloudflare-moq.js';
import type { ParticipantApplicationService } from '../../services/participant-application-service.js';
import { SessionAuthenticationError } from '../auth.js';
import { generalApiRateLimit } from '../rate-limit.js';

const Slug = Type.String({ minLength: 22, maxLength: 256 });
const SlugParams = Type.Object({ slug: Slug });
const ShareParams = Type.Object({ slug: Slug, shareId: ScreenMoqSubscribeRequestSchema.properties.shareId });

export function registerScreenMoqRoutes(app: FastifyInstance, dependencies: {
  participants: ParticipantApplicationService;
  screenMoq: CloudflareMoqService;
}): void {
  const base = '/api/v1/meetings/:slug/screen-moq';
  const limit = app.rateLimit({ ...generalApiRateLimit(), groupId: 'screen-moq' });
  const publicationOptions = { schema: { params: ShareParams }, preHandler: limit };

  function participant(request: FastifyRequest<{ Params: { slug: string } }>) {
    const { slug } = request.params;
    const raw = readMeetingSessionCookie(request, participantCookie, slug);
    if (!raw) throw new SessionAuthenticationError();
    return dependencies.participants.authenticate(raw, slug);
  }

  app.get<{ Params: { slug: string } }>(base, {
    schema: { params: SlugParams, response: { 200: ScreenMoqStatusResponseSchema } },
    preHandler: app.rateLimit({ ...generalApiRateLimit({ max: 480 }), groupId: 'screen-moq-status' }),
    logLevel: 'warn'
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    participant(request);
    return dependencies.screenMoq.status(request.params.slug);
  });

  app.post<{ Params: { slug: string } }>(base + '/publish', {
    schema: { params: SlugParams, response: { 200: ScreenMoqConnectionResponseSchema } },
    preHandler: limit
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return dependencies.screenMoq.publish(request.params.slug, participant(request));
  });

  app.post<{ Params: { slug: string }; Body: ScreenMoqSubscribeRequest }>(base + '/subscribe', {
    bodyLimit: 1024,
    schema: {
      params: SlugParams,
      body: ScreenMoqSubscribeRequestSchema,
      response: { 200: ScreenMoqConnectionResponseSchema }
    },
    preValidation: async (request) => {
      if (!Value.Check(ScreenMoqSubscribeRequestSchema, request.body)) throw domainError('UNSUPPORTED_CLIENT');
    },
    preHandler: limit
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return dependencies.screenMoq.subscribe(request.params.slug, participant(request), request.body.shareId);
  });

  app.put<{ Params: { slug: string; shareId: string } }>(base + '/publications/:shareId', publicationOptions, async (request, reply) => {
    const { slug, shareId } = request.params;
    dependencies.screenMoq.heartbeat(slug, participant(request), shareId);
    return reply.status(204).send();
  });

  app.delete<{ Params: { slug: string; shareId: string } }>(base + '/publications/:shareId', publicationOptions, async (request, reply) => {
    const { slug, shareId } = request.params;
    await dependencies.screenMoq.stop(slug, participant(request), shareId);
    return reply.status(204).send();
  });
}
