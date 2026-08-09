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
  const headers = jsonHeaders(init.headers);
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers
  });
  if (!response.ok) throw await parseApiError(response);
  const body: unknown = await response.json();
  if (!Value.Check(schema, body)) throw new ApiRequestError('The server returned an invalid response.', response.status);
  return body as T;
}

export async function apiNoContent(path: string, init: RequestInit = {}): Promise<void> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: jsonHeaders(init.headers)
  });
  if (!response.ok) throw await parseApiError(response);
}

function jsonHeaders(value: HeadersInit | undefined): Record<string, string> {
  const headers = value instanceof Headers
    ? Object.fromEntries(value.entries())
    : Array.isArray(value)
      ? Object.fromEntries(value)
      : { ...value };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-type') delete headers[key];
  }
  return { ...headers, 'Content-Type': 'application/json' };
}

async function parseApiError(response: Response): Promise<ApiRequestError> {
  let body: unknown;
  try { body = await response.json(); } catch { return new ApiRequestError('The request could not be completed.', response.status); }
  if (!Value.Check(ApiErrorResponseSchema, body)) return new ApiRequestError('The request could not be completed.', response.status);
  const details = body as ApiErrorResponse;
  return new ApiRequestError(details.error.message, response.status, details);
}
