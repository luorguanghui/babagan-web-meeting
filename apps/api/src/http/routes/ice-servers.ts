import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config.js';
import { participantCookie, readSignedSessionCookie } from '../../security/session-token.js';
import type {
  ActiveParticipantSession,
  ParticipantApplicationService
} from '../../services/participant-application-service.js';
import { fetchCloudflareTurnIceServers } from '../../services/cloudflare-turn.js';
import { createTurnCredentials } from '../../services/turn-credentials.js';
import { SessionAuthenticationError } from '../auth.js';
import { generalApiRateLimit } from '../rate-limit.js';

type IceTurnProviderRequest = 'auto' | 'coturn' | 'cloudflare';

const SlugParamsSchema = Type.Object({ slug: Type.String({ minLength: 22, maxLength: 256 }) });
const IceServersQuerySchema = Type.Object({
  turnProvider: Type.Optional(Type.Union([
    Type.Literal('auto'),
    Type.Literal('coturn'),
    Type.Literal('cloudflare')
  ]))
});
const IceServerSchema = Type.Object({
  urls: Type.Array(Type.String()),
  username: Type.Optional(Type.String()),
  credential: Type.Optional(Type.String())
});
const IceServersResponseSchema = Type.Object({
  iceServers: Type.Array(IceServerSchema),
  availableTurnProviders: Type.Array(Type.Union([Type.Literal('coturn'), Type.Literal('cloudflare')])),
  turnProvider: Type.Union([Type.Literal('coturn'), Type.Literal('cloudflare')]),
  turnCredentialsExpiresAt: Type.Integer()
});

export function registerIceServersRoutes(app: FastifyInstance, dependencies: {
  participants: ParticipantApplicationService;
  config: AppConfig;
}): void {
  app.get('/api/v1/meetings/:slug/ice-servers', {
    schema: {
      params: SlugParamsSchema,
      querystring: IceServersQuerySchema,
      response: { 200: IceServersResponseSchema }
    },
    preHandler: app.rateLimit(generalApiRateLimit())
  }, async (request, reply) => {
    const value = slug(request.params);
    const session = participantSession(request, dependencies.participants, value);
    const turn = createTurnCredentials({
      secret: dependencies.config.p2pTurnSecret,
      participantIdentity: session.identity,
      ttlSeconds: dependencies.config.p2pTurnTtlSeconds,
      nowSeconds: Date.now() / 1_000
    });
    reply.header('Cache-Control', 'no-store');
    const availableTurnProviders = resolveAvailableTurnProviders(dependencies.config);

    const coturn = {
      iceServers: [
        { urls: dependencies.config.p2pStunUrls },
        { urls: dependencies.config.p2pTurnUrls, ...turn }
      ],
      availableTurnProviders,
      turnProvider: 'coturn' as const,
      turnCredentialsExpiresAt: Number(turn.username.split(':', 1)[0])
    };
    if (resolveRequestedTurnProvider(request.query, dependencies.config) !== 'cloudflare') return coturn;

    try {
      return await fetchCloudflareTurnIceServers({
        keyId: dependencies.config.cloudflareTurnKeyId!,
        apiToken: dependencies.config.cloudflareTurnApiToken!,
        ttlSeconds: dependencies.config.cloudflareTurnTtlSeconds ?? 600,
        connectIps: dependencies.config.cloudflareTurnConnectIps
      }).then((response) => ({ ...response, availableTurnProviders }));
    } catch {
      // Keep the existing coturn path as an availability fallback while the
      // managed provider is being rolled out or temporarily unavailable.
      return coturn;
    }
  });
}

function participantSession(
  request: FastifyRequest,
  participants: ParticipantApplicationService,
  slugValue: string
): ActiveParticipantSession {
  const raw = readSignedSessionCookie(request, participantCookie);
  if (!raw) throw new SessionAuthenticationError();
  return participants.authenticate(raw, slugValue);
}

function slug(params: unknown): string {
  return (params as { slug: string }).slug;
}

function resolveRequestedTurnProvider(query: unknown, config: AppConfig): 'coturn' | 'cloudflare' {
  const requested = (query as { turnProvider?: IceTurnProviderRequest }).turnProvider ?? 'auto';
  if (requested === 'auto') return config.p2pTurnProvider ?? 'coturn';
  return requested;
}

function resolveAvailableTurnProviders(config: AppConfig): Array<'coturn' | 'cloudflare'> {
  return config.cloudflareTurnKeyId && config.cloudflareTurnApiToken
    ? ['coturn', 'cloudflare']
    : ['coturn'];
}
