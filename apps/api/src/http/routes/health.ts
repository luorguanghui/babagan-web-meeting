import type { FastifyInstance } from 'fastify';

import { domainError } from '../../domain/errors.js';
import type { MediaService } from '../../livekit/media-service.js';
import type { HostApplicationService } from '../../services/host-application-service.js';

export function registerHealthRoutes(app: FastifyInstance, dependencies: {
  hosts: HostApplicationService;
  media: MediaService;
}): void {
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    try {
      dependencies.hosts.checkDatabase();
      await dependencies.media.ping();
      return { status: 'ready' };
    } catch {
      throw domainError('MEDIA_SERVICE_UNAVAILABLE');
    }
  });
}
