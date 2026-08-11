import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config.js';
import { participantCookie, readSignedSessionCookie } from '../../security/session-token.js';
import type { ParticipantApplicationService } from '../../services/participant-application-service.js';
import { SessionAuthenticationError } from '../auth.js';
import { generalApiRateLimit } from '../rate-limit.js';

const SlugParamsSchema = Type.Object({ slug: Type.String({ minLength: 22, maxLength: 256 }) });
const IceServerSchema = Type.Object({
  urls: Type.Array(Type.String()),
  username: Type.Optional(Type.String()),
  credential: Type.Optional(Type.String())
});
const IceServersResponseSchema = Type.Object({ iceServers: Type.Array(IceServerSchema) });

export function registerIceServersRoutes(app: FastifyInstance, dependencies: {
  participants: ParticipantApplicationService;
  config: AppConfig;
}): void {
  app.get('/api/v1/meetings/:slug/ice-servers', {
    schema: { params: SlugParamsSchema, response: { 200: IceServersResponseSchema } },
    preHandler: app.rateLimit(generalApiRateLimit())
  }, async (request) => {
    const value = slug(request.params);
    participantSession(request, dependencies.participants, value);

    return { iceServers: [{ urls: dependencies.config.p2pStunUrls }] };
  });
}

function participantSession(
  request: FastifyRequest,
  participants: ParticipantApplicationService,
  slugValue: string
): void {
  const raw = readSignedSessionCookie(request, participantCookie);
  if (!raw) throw new SessionAuthenticationError();
  participants.authenticate(raw, slugValue);
}

function slug(params: unknown): string {
  return (params as { slug: string }).slug;
}
