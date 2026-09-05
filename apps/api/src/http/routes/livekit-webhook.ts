import type { FastifyInstance } from 'fastify';

import type { WebhookHandler } from '../../livekit/webhook-handler.js';
import type { P2pRoomRegistry } from '../../p2p/room-registry.js';

export function registerLiveKitWebhookRoute(
  app: FastifyInstance,
  webhooks: WebhookHandler,
  p2p: P2pRoomRegistry
): void {
  app.addContentTypeParser('application/webhook+json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  app.post('/internal/livekit/webhook', async (request, reply) => {
    const body = request.body;
    if (!(body instanceof Uint8Array)) throw new Error('Expected raw webhook body');
    const result = await webhooks.handle(body, request.headers.authorization);
    if (result.shareGone) p2p.broadcastShareGone(result.shareGone.slug, result.shareGone.reason);
    return reply.status(204).send();
  });
}
