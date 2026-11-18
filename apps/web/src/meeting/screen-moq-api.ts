import {
  ScreenMoqConnectionResponseSchema, ScreenMoqStatusResponseSchema,
  type ScreenMoqConnectionResponse, type ScreenMoqStatusResponse
} from '@meeting/contracts';
import { apiNoContent, apiRequest } from '../api/client.js';

export function createScreenMoqApi(slug: string) {
  const base = `/meetings/${encodeURIComponent(slug)}/screen-moq`;
  const publicationPath = (id: string) => `${base}/publications/${encodeURIComponent(id)}`;
  const deadline = (signal: AbortSignal, ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  return {
    status: (signal: AbortSignal) => apiRequest<ScreenMoqStatusResponse>(base, ScreenMoqStatusResponseSchema, { signal: deadline(signal, 6_000) }),
    publish: (signal: AbortSignal) => apiRequest<ScreenMoqConnectionResponse>(`${base}/publish`, ScreenMoqConnectionResponseSchema, {
      method: 'POST', signal: deadline(signal, 18_000)
    }),
    ready: (id: string, signal: AbortSignal) => apiNoContent(publicationPath(id), { method: 'PUT', signal: deadline(signal, 7_000) }),
    stop: (id: string) => apiNoContent(publicationPath(id), { method: 'DELETE', signal: AbortSignal.timeout(6_000) }),
    subscribe: (shareId: string, signal: AbortSignal) => apiRequest<ScreenMoqConnectionResponse>(`${base}/subscribe`, ScreenMoqConnectionResponseSchema, {
      method: 'POST', body: JSON.stringify({ shareId }), signal: deadline(signal, 10_000)
    })
  };
}
