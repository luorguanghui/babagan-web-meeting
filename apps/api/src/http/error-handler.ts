import { randomUUID } from 'node:crypto';

import type { ApiErrorCode, ApiErrorResponse } from '@meeting/contracts';
import type { FastifyError, FastifyInstance } from 'fastify';

import { DomainError } from '../domain/errors.js';
import { InvalidLiveKitWebhookError } from '../livekit/webhook-handler.js';
import { SessionAuthenticationError } from './auth.js';
import { OriginValidationError } from './origin.js';
import { RateLimitError } from './rate-limit.js';

const publicErrors: Record<ApiErrorCode, { statusCode: number; message: string }> = {
  MEETING_NOT_FOUND: { statusCode: 404, message: 'Meeting not found' },
  MEETING_EXPIRED: { statusCode: 410, message: 'Meeting has ended' },
  MEETING_FULL: { statusCode: 409, message: 'Meeting is full' },
  INVALID_MEETING_PASSWORD: { statusCode: 401, message: 'Meeting password is invalid' },
  ADMIN_AUTH_FAILED: { statusCode: 401, message: 'Authentication failed' },
  SHARE_ALREADY_ACTIVE: { statusCode: 409, message: 'Screen sharing is already active' },
  SHARE_NOT_AUTHORIZED: { statusCode: 403, message: 'Operation is not authorized' },
  UNSUPPORTED_CLIENT: { statusCode: 400, message: 'Request is invalid' },
  RATE_LIMITED: { statusCode: 429, message: 'Too many attempts; try again later' },
  MEDIA_SERVICE_UNAVAILABLE: { statusCode: 503, message: 'Media service is unavailable' }
};

export interface ApiErrorDetails {
  statusCode: number;
  body: ApiErrorResponse;
}

export function apiErrorDetails(error: unknown, correlationId: string): ApiErrorDetails {
  if (error instanceof DomainError) {
    if (error.code === 'MEETING_ALREADY_ACTIVE') {
      return details('MEETING_FULL', 409, 'An active meeting already exists', correlationId);
    }
    const mapped = publicErrors[error.code];
    return details(error.code, mapped.statusCode, mapped.message, correlationId);
  }
  if (error instanceof RateLimitError) {
    return details('RATE_LIMITED', error.statusCode, publicErrors.RATE_LIMITED.message, correlationId);
  }
  if (error instanceof SessionAuthenticationError) {
    return details('ADMIN_AUTH_FAILED', 401, 'Authentication failed', correlationId);
  }
  if (error instanceof OriginValidationError || error instanceof InvalidLiveKitWebhookError) {
    return details('SHARE_NOT_AUTHORIZED', 403, 'Operation is not authorized', correlationId);
  }
  if (isValidationError(error)) {
    return details('UNSUPPORTED_CLIENT', 400, 'Request validation failed', correlationId);
  }
  return details('MEDIA_SERVICE_UNAVAILABLE', 500, 'Internal server error', correlationId);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const mapped = apiErrorDetails(new DomainError('MEETING_NOT_FOUND'), request.id || randomUUID());
    reply.status(mapped.statusCode).send(mapped.body);
  });
  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.id || randomUUID();
    const mapped = apiErrorDetails(error, correlationId);
    if (mapped.statusCode >= 500) {
      request.log.error({ correlationId }, 'Unhandled API error');
    }
    reply.status(mapped.statusCode).send(mapped.body);
  });
}

function details(
  code: ApiErrorCode,
  statusCode: number,
  message: string,
  correlationId: string
): ApiErrorDetails {
  return { statusCode, body: { error: { code, message, correlationId } } };
}

function isValidationError(error: unknown): error is FastifyError {
  return error instanceof Error && 'validation' in error;
}
