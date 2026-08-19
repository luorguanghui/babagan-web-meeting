import type { FastifyRequest } from 'fastify';

interface RateLimitOverrides {
  max?: number;
  timeWindow?: number;
}

export class RateLimitError extends Error {
  readonly code = 'RATE_LIMITED';

  constructor(readonly statusCode: number) {
    super('RATE_LIMITED');
    this.name = 'RateLimitError';
  }
}

const rateLimitErrorResponse = (_request: FastifyRequest, context: { statusCode: number }) =>
  new RateLimitError(context.statusCode);

export function adminPasswordRateLimit(overrides: RateLimitOverrides = {}) {
  return {
    max: 5,
    timeWindow: 15 * 60_000,
    groupId: 'admin-password',
    keyGenerator: (request: FastifyRequest) => `admin:${request.ip}`,
    errorResponseBuilder: rateLimitErrorResponse,
    ...overrides
  };
}

export function meetingPasswordRateLimit(overrides: RateLimitOverrides = {}) {
  return {
    max: 5,
    timeWindow: 15 * 60_000,
    groupId: 'meeting-password',
    keyGenerator: (request: FastifyRequest) => `meeting:${request.ip}:${meetingSlug(request)}`,
    errorResponseBuilder: rateLimitErrorResponse,
    ...overrides
  };
}

export function generalApiRateLimit(overrides: RateLimitOverrides = {}) {
  return {
    max: 120,
    timeWindow: 60_000,
    groupId: 'general-api',
    keyGenerator: (request: FastifyRequest) => `api:${request.ip}`,
    errorResponseBuilder: rateLimitErrorResponse,
    ...overrides
  };
}

function meetingSlug(request: FastifyRequest): string {
  const params = request.params;
  if (typeof params === 'object' && params !== null && 'slug' in params) {
    const slug = params.slug;
    if (typeof slug === 'string') return slug;
  }
  return 'unknown';
}
