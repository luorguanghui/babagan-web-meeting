import type { CloudflareMoqService } from '../../services/cloudflare-moq.js';
import type { CloudflareSfuService } from '../../services/cloudflare-sfu.js';
import type { FastifyInstance } from 'fastify';

import type { WebhookHandler } from '../../livekit/webhook-handler.js';
import type { P2pRoomRegistry } from '../../p2p/room-registry.js';

export function registerLiveKitWebhookRoute(
  app: FastifyInstance,
  webhooks: WebhookHandler,
  p2p: P2pRoomRegistry,
  screenSfu?: CloudflareSfuService,
  screenMoq?: CloudflareMoqService
): void {
  app.addContentTypeParser('application/webhook+json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  app.post('/internal/livekit/webhook', async (request, reply) => {
    const body = request.body;
    if (!(body instanceof Uint8Array)) throw new Error('Expected raw webhook body');
    const result = await webhooks.handle(body, request.headers.authorization);
    if (result.participantLeft) {
      const { slug, identity } = result.participantLeft;
      await Promise.all([screenMoq?.reconcile(slug), screenSfu?.closeParticipant(slug, identity)]);
    }
    if (result.shareGone) {
      await Promise.all([screenMoq?.reconcile(result.shareGone.slug), screenSfu?.reconcile(result.shareGone.slug)]);
      p2p.broadcastShareGone(result.shareGone.slug, result.shareGone.reason);
    }
    return reply.status(204).send();
  });
}
