import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { openMoqPublisher, openMoqSubscriber } from './screen-moq-media.js';
import { useScreenMoq } from './use-screen-moq.js';

vi.mock('./screen-moq-media.js', () => ({ openMoqSubscriber: vi.fn(), openMoqPublisher: vi.fn() }));
vi.mock('./screen-moq-support.js', () => ({
  supportsMoqPublisher: () => true,
  supportsMoqSubscriber: () => true
}));

const publication = { shareId: 'screen-1', sharerIdentity: 'owner-1', sharerName: 'Ada', namespace: 'screen' };
const grant = { shareId: 'screen-1', namespace: 'screen', url: 'https://draft-18.cloudflare.mediaoverquic.com/test-token' };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('subscribes to a ready remote share and closes the media when it is withdrawn', async () => {
  const stream = {} as MediaStream;
  const close = vi.fn();
  vi.mocked(openMoqSubscriber).mockResolvedValue({ stream, close, closed: new Promise(() => {}) });
  let activePublication: typeof publication | null = publication;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/subscribe')
    ? Response.json(grant)
    : Response.json({ available: true, publication: activePublication }));
  vi.stubGlobal('fetch', fetcher);

  const { result } = renderHook(() => useScreenMoq('room', 'viewer', true));
  await waitFor(() => expect(result.current.stream).toBe(stream));
  expect(result.current.remote).toEqual(publication);
  expect(result.current.publishAvailable).toEqual(true);
  expect(openMoqSubscriber).toHaveBeenCalledExactlyOnceWith(grant, expect.any(AbortSignal));
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/api/v1/meetings/room/screen-moq', '/api/v1/meetings/room/screen-moq/subscribe'
  ]);

  activePublication = null;
  await waitFor(() => expect(result.current.stream).toBeUndefined(), { timeout: 4_000 });
  expect(close).toHaveBeenCalledOnce();
});

it('re-publishes once after a relay failure without asking for screen capture again', async () => {
  const closed = Promise.withResolvers<void>();
  const second = { ...grant, shareId: 'screen-2' };
  const stream = {} as MediaStream;
  const stopFirst = vi.fn();
  vi.mocked(openMoqPublisher)
    .mockResolvedValueOnce({ close: stopFirst, closed: closed.promise })
    .mockResolvedValueOnce({ close: vi.fn(), closed: new Promise(() => {}) });
  let publishes = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/publish')) return Response.json(++publishes === 1 ? grant : second);
    if (init?.method === 'PUT' || init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ available: true, publication: null });
  }));
  const { result } = renderHook(() => useScreenMoq('room', 'owner-1', true));
  await act(async () => {
    await result.current.publish(stream, { codec: 'h264', maxBitrate: 5_000_000, frameRate: 30, degradationPreference: 'maintain-framerate' });
  });

  await act(async () => { closed.resolve(); });
  await waitFor(() => expect(openMoqPublisher).toHaveBeenCalledTimes(2));
  expect(openMoqPublisher).toHaveBeenLastCalledWith(second, stream, expect.anything(), expect.any(AbortSignal));
  expect(stopFirst).toHaveBeenCalledOnce();
  expect(result.current.publisherFailed).toBe(false);
});

it('exposes an unavailable mode by default and does not poll a disabled server', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json({ available: false, publication: null }));
  vi.stubGlobal('fetch', fetcher);

  const { result } = renderHook(() => useScreenMoq('room', 'viewer', true));
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(result.current.publishAvailable).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
});
