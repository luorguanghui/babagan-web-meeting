import { CloudflareSfuAnswerRequestSchema, CloudflareSfuPublishRequestSchema, CloudflareSfuReadyRequestSchema, CloudflareSfuSessionResponseSchema, CloudflareSfuStatusResponseSchema, CloudflareSfuSubscribeRequestSchema, type CloudflareSfuPublishRequest } from '@meeting/contracts';
import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { domainError } from '../../domain/errors.js';
import { participantCookie, readSignedSessionCookie } from '../../security/session-token.js';
import type { ParticipantApplicationService } from '../../services/participant-application-service.js';
import type { CloudflareSfuService } from '../../services/cloudflare-sfu.js';
import { SessionAuthenticationError } from '../auth.js';
import { generalApiRateLimit } from '../rate-limit.js';

export function registerScreenSfuRoutes(app: FastifyInstance, dependencies: { participants: ParticipantApplicationService; screenSfu: CloudflareSfuService }): void {
  const base = '/api/v1/meetings/:slug/screen-sfu';
  const slugSchema = Type.Object({ slug: Type.String({ minLength: 22, maxLength: 256 }) });
  const sessionSchema = Type.Object({ slug: Type.String({ minLength: 22, maxLength: 256 }), sessionId: Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' }) });
  function options(body?: TSchema, response?: TSchema, withSession = false) {
    return {
      bodyLimit: 140_000,
      schema: { params: withSession ? sessionSchema : slugSchema, ...(body ? { body } : {}), ...(response ? { response: { 200: response } } : {}) },
      preValidation: async (request: FastifyRequest) => { if (body && !Value.Check(body, request.body)) throw domainError('UNSUPPORTED_CLIENT'); },
      preHandler: app.rateLimit(generalApiRateLimit())
    };
  }
  function participant(request: FastifyRequest) {
    const slug = (request.params as { slug: string }).slug;
    const raw = readSignedSessionCookie(request, participantCookie);
    if (!raw) throw new SessionAuthenticationError();
    return { slug, owner: dependencies.participants.authenticate(raw, slug) };
  }
  app.get(base, options(undefined, CloudflareSfuStatusResponseSchema), async (request, reply) => {
    const { slug } = participant(request); reply.header('Cache-Control', 'no-store');
    return dependencies.screenSfu.status(slug);
  });
  app.post(base + '/publish', options(CloudflareSfuPublishRequestSchema, CloudflareSfuSessionResponseSchema), async (request, reply) => {
    const { slug, owner } = participant(request); reply.header('Cache-Control', 'no-store');
    return dependencies.screenSfu.publish(slug, owner, request.body as CloudflareSfuPublishRequest);
  });
  app.post(base + '/publish/ready', options(CloudflareSfuReadyRequestSchema), async (request, reply) => {
    const { slug, owner } = participant(request);
    await dependencies.screenSfu.ready(slug, owner, (request.body as { sessionId: string }).sessionId);
    return reply.status(204).send();
  });
  app.post(base + '/subscribe', options(CloudflareSfuSubscribeRequestSchema, CloudflareSfuSessionResponseSchema), async (request, reply) => {
    const { slug, owner } = participant(request); reply.header('Cache-Control', 'no-store');
    return dependencies.screenSfu.subscribe(slug, owner, (request.body as { shareId: string }).shareId);
  });
  app.put(base + '/sessions/:sessionId/answer', options(CloudflareSfuAnswerRequestSchema, undefined, true), async (request, reply) => {
    const { slug, owner } = participant(request);
    await dependencies.screenSfu.answer(slug, owner, (request.params as { sessionId: string }).sessionId, (request.body as { sessionDescription: { type: 'answer'; sdp: string } }).sessionDescription);
    return reply.status(204).send();
  });
  app.delete(base + '/sessions/:sessionId', options(undefined, undefined, true), async (request, reply) => {
    const { slug, owner } = participant(request);
    await dependencies.screenSfu.stop(slug, owner, (request.params as { sessionId: string }).sessionId);
    return reply.status(204).send();
  });
}
