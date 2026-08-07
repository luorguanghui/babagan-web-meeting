import { ApiErrorResponseSchema, type ApiErrorResponse } from '@meeting/contracts';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly details?: ApiErrorResponse) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export async function apiRequest<T>(path: string, schema: TSchema, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init.headers }
  });
  if (!response.ok) throw await parseApiError(response);
  const body: unknown = await response.json();
  if (!Value.Check(schema, body)) throw new ApiRequestError('The server returned an invalid response.', response.status);
  return body as T;
}

async function parseApiError(response: Response): Promise<ApiRequestError> {
  let body: unknown;
  try { body = await response.json(); } catch { return new ApiRequestError('The request could not be completed.', response.status); }
  if (!Value.Check(ApiErrorResponseSchema, body)) return new ApiRequestError('The request could not be completed.', response.status);
  const details = body as ApiErrorResponse;
  return new ApiRequestError(details.error.message, response.status, details);
}
