import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { participantCookie, readSignedSessionCookie } from '../../security/session-token.js';
import type {
  ActiveParticipantSession,
  P2pStatsReport,
  ParticipantApplicationService
} from '../../services/participant-application-service.js';
import { SessionAuthenticationError } from '../auth.js';
import { generalApiRateLimit } from '../rate-limit.js';

const SlugParamsSchema = Type.Object({ slug: Type.String({ minLength: 22, maxLength: 256 }) });

/**
 * Anonymous P2P quality report; must not contain media, SDP, IP or identity.
 * The meeting id is hashed server-side, and `sessionId` is an anonymous
 * join-session id the client generates per join.
 */
const P2pStatsReportSchema = Type.Object({
  sessionId: Type.String({ minLength: 4, maxLength: 128 }),
  attempts: Type.Integer({ minimum: 0, maximum: 10_000 }),
  p2pSucceeded: Type.Integer({ minimum: 0, maximum: 10_000 }),
  fallbacks: Type.Integer({ minimum: 0, maximum: 10_000 }),
  avgSetupMs: Type.Number({ minimum: 0, maximum: 3_600_000 }),
  avgRttMs: Type.Number({ minimum: 0, maximum: 60_000 }),
  maxLossPct: Type.Number({ minimum: 0, maximum: 100 })
}, { additionalProperties: false });

export function registerP2pStatsRoutes(app: FastifyInstance, dependencies: {
  participants: ParticipantApplicationService;
}): void {
  app.post('/api/v1/meetings/:slug/p2p-stats', {
    schema: { params: SlugParamsSchema, body: P2pStatsReportSchema },
    preHandler: app.rateLimit(generalApiRateLimit())
  }, async (request, reply) => {
    const value = slug(request.params);
    const session = participantSession(request, dependencies.participants, value);
    dependencies.participants.recordP2pStats(session, request.body as P2pStatsReport);
    return reply.status(204).send();
  });
}

/**
 * The report is sent on leave or after the meeting ended, so the session may
 * already be revoked and the meeting terminal — the same window the leave
 * endpoint tolerates. The payload is anonymous and rate-limited, so a stale
 * cookie only permits recording one identity-free audit row.
 */
function participantSession(
  request: FastifyRequest,
  participants: ParticipantApplicationService,
  slugValue: string
): ActiveParticipantSession {
  const raw = readSignedSessionCookie(request, participantCookie);
  if (!raw) throw new SessionAuthenticationError();
  return participants.authenticateForLeave(raw, slugValue);
}

function slug(params: unknown): string {
  return (params as { slug: string }).slug;
}
