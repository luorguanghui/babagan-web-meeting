import type { FastifyInstance } from 'fastify';

import type { WebhookHandler } from '../../livekit/webhook-handler.js';

export function registerLiveKitWebhookRoute(app: FastifyInstance, webhooks: WebhookHandler): void {
  app.addContentTypeParser('application/webhook+json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  app.post('/internal/livekit/webhook', async (request, reply) => {
    const body = request.body;
    if (!(body instanceof Uint8Array)) throw new Error('Expected raw webhook body');
    await webhooks.handle(body, request.headers.authorization);
    return reply.status(204).send();
  });
}
