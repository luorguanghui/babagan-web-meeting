import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { registerErrorHandler } from './http/error-handler.js';
import { registerStrictOriginValidation } from './http/origin.js';
import { registerHealthRoutes } from './http/routes/health.js';
import { registerIceServersRoutes } from './http/routes/ice-servers.js';
import { registerLiveKitWebhookRoute } from './http/routes/livekit-webhook.js';
import { registerMeetingRoutes } from './http/routes/meetings.js';
import { registerParticipantRoutes } from './http/routes/participants.js';
import { registerP2pSignalingRoute } from './http/routes/p2p-signaling.js';
import type { MediaService } from './livekit/media-service.js';
import type { WebhookHandler } from './livekit/webhook-handler.js';
import { P2pRoomRegistry } from './p2p/room-registry.js';
import type { HostApplicationService } from './services/host-application-service.js';
import type { MeetingService } from './services/meeting-service.js';
import type { ParticipantApplicationService } from './services/participant-application-service.js';

export interface AppDependencies {
  config: AppConfig;
  meetings: MeetingService;
  hosts: HostApplicationService;
  participants: ParticipantApplicationService;
  media: MediaService;
  webhooks: WebhookHandler;
  /** Shared P2P room registry; created per-app when not provided. */
  p2p?: P2pRoomRegistry;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: dependencies.config.nodeEnv !== 'test' });
  await app.register(cookie, { secret: dependencies.config.cookieSecret });
  await app.register(cors, { origin: dependencies.config.publicBaseUrl.origin, credentials: true });
  await app.register(helmet);
  await app.register(rateLimit, { global: false });
  await app.register(websocket);
  registerErrorHandler(app);
  registerStrictOriginValidation(
    app,
    dependencies.config.publicBaseUrl,
    new Set(['/internal/livekit/webhook'])
  );
  const p2p = dependencies.p2p ?? new P2pRoomRegistry();
  const appDependencies = { ...dependencies, p2p };
  registerMeetingRoutes(app, appDependencies);
  registerParticipantRoutes(app, appDependencies);
  registerIceServersRoutes(app, dependencies);
  registerLiveKitWebhookRoute(app, dependencies.webhooks);
  registerP2pSignalingRoute(app, appDependencies);
  registerHealthRoutes(app, dependencies);
  await app.ready();
  return app;
}
