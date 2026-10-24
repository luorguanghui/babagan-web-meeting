import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCloudflareScreen } from './use-cloudflare-screen.js';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('does not request relay or retry after terminal subscription authorization failure', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', class extends EventTarget { close() {} });
  vi.stubGlobal('MediaStream', class {});
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/screen-sfu')
    ? Response.json({ available: true, publication: null }) : new Response(null, { status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  const ice = async () => [];
  const { result } = renderHook(() => useCloudflareScreen('meeting', 'Ben', ice));
  await act(async () => {
    result.current.announce({ shareId: 'share', sessionId: 'publisher', sharerIdentity: 'Ada', sharerName: 'Ada', tracks: [{ kind: 'video', trackName: 'screen' }] });
  });
  expect(result.current.error).toContain('Cloudflare SFU');
  expect(result.current.recovering).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(result.current.recovering).toBe(false);
  expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/subscribe'))).toHaveLength(1);
});
