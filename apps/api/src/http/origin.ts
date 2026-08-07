import type { FastifyInstance, FastifyRequest } from 'fastify';

const modifyingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class OriginValidationError extends Error {
  readonly statusCode = 403;

  constructor() {
    super('Invalid request origin');
    this.name = 'OriginValidationError';
  }
}

export function assertTrustedOrigin(request: FastifyRequest, allowedOrigin: URL): void {
  if (request.headers.origin !== allowedOrigin.origin) throw new OriginValidationError();
}

export function registerStrictOriginValidation(app: FastifyInstance, allowedOrigin: URL): void {
  app.addHook('onRequest', (request, _reply, done) => {
    if (modifyingMethods.has(request.method)) assertTrustedOrigin(request, allowedOrigin);
    done();
  });
}
