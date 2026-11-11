import { createHmac } from 'node:crypto';
import {
  SCREEN_SHARE_QUALITY_BODY_LIMIT,
  ScreenShareQualityReportSchema,
  type ScreenShareQualityReport
} from '@meeting/contracts';
import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../../config.js';
import { participantCookie, readMeetingSessionCookie } from '../../security/session-token.js';
import type { ParticipantApplicationService } from '../../services/participant-application-service.js';
import { SessionAuthenticationError } from '../auth.js';
import { generalApiRateLimit } from '../rate-limit.js';

export function registerScreenShareQualityRoutes(app: FastifyInstance, dependencies: {
  config: AppConfig;
  participants: ParticipantApplicationService;
}): void {
  app.post<{ Params: { slug: string }; Body: ScreenShareQualityReport }>('/api/v1/meetings/:slug/screen-share-quality', {
    bodyLimit: SCREEN_SHARE_QUALITY_BODY_LIMIT,
    logLevel: 'warn',
    schema: {
      params: Type.Object({ slug: Type.String({ minLength: 22, maxLength: 256 }) }),
      body: ScreenShareQualityReportSchema
    },
    // Reject extraneous properties instead of Fastify's usual removal and coercion.
    validatorCompiler: ({ schema }) => data => Value.Check(schema as TSchema, data)
      ? true : { error: [{
        keyword: 'screenShareQuality', instancePath: '', schemaPath: '#', params: {},
        message: 'must match the screen share quality schema'
      }] },
    onRequest: app.rateLimit({ ...generalApiRateLimit(), groupId: 'screen-share-quality' })
  }, async (request, reply) => {
    const { slug } = request.params;
    const token = readMeetingSessionCookie(request, participantCookie, slug);
    if (!token) throw new SessionAuthenticationError();

    const { participants, config } = dependencies;
    const report = request.body;
    const session = participants.authenticate(token, slug);
    const meetingKey = createHmac('sha256', config.cookieSecret)
      .update('screen-share-quality:').update(session.meetingId).digest('hex').slice(0, 32);
    // The rotating API log is the sink. Use the app logger so the telemetry
    // row does not inherit request URL, headers or client address.
    app.log.info({ event: 'screen_share_quality', meetingKey, ...report }, 'Screen share quality');
    return reply.status(204).send();
  });
}
