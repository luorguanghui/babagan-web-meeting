import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import { participantCookie, readSignedSessionCookie } from '../../security/session-token.js';
import type { ParticipantApplicationService } from '../../services/participant-application-service.js';
import { createTurnCredentials } from '../../services/turn-credentials.js';
import { SessionAuthenticationError } from '../auth.js';
import { generalApiRateLimit } from '../rate-limit.js';

export function registerIceServersRoutes(app: FastifyInstance, dependencies: { participants: ParticipantApplicationService; config: AppConfig }): void {
  app.get('/api/v1/meetings/:slug/ice-servers', {
    schema: {
      params: Type.Object({ slug: Type.String({ minLength: 22, maxLength: 256 }) }),
      querystring: Type.Object({ turnProvider: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('coturn')])) }),
      response: { 200: Type.Object({
        iceServers: Type.Array(Type.Object({ urls: Type.Array(Type.String()), username: Type.Optional(Type.String()), credential: Type.Optional(Type.String()) })),
        availableTurnProviders: Type.Array(Type.Literal('coturn')), turnProvider: Type.Literal('coturn'), turnCredentialsExpiresAt: Type.Integer()
      }) }
    }, preHandler: app.rateLimit(generalApiRateLimit())
  }, async (request: FastifyRequest, reply) => {
    const slug = (request.params as { slug: string }).slug;
    const raw = readSignedSessionCookie(request, participantCookie);
    if (!raw) throw new SessionAuthenticationError();
    const session = dependencies.participants.authenticate(raw, slug);
    const config = dependencies.config;
    const turn = createTurnCredentials({ secret: config.p2pTurnSecret, participantIdentity: session.identity, ttlSeconds: config.p2pTurnTtlSeconds, nowSeconds: Date.now() / 1000 });
    const ownStunUrls = config.p2pTurnUrls.flatMap((url) => {
      const match = /^turn:([^?]+)(?:\?transport=udp)?$/i.exec(url);
      return match ? [`stun:${match[1]}`] : [];
    });
    reply.header('Cache-Control', 'no-store');
    return { iceServers: [{ urls: [...new Set([...ownStunUrls, ...config.p2pStunUrls])] }, { urls: config.p2pTurnUrls, ...turn }], availableTurnProviders: ['coturn'], turnProvider: 'coturn', turnCredentialsExpiresAt: Number(turn.username.split(':', 1)[0]) };
  });
}
