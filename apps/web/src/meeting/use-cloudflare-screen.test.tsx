import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCloudflareScreen } from './use-cloudflare-screen.js';

const fake = vi.hoisted(() => ({ sessions: [] as Array<{
  deps: { onRecoveryNeeded?: (error: Error) => void; onStream?: (stream: MediaStream) => void };
  subscribe: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
}> }));
vi.mock('../api/client.js', () => ({ apiRequest: vi.fn(async () => ({ available: true })) }));
vi.mock('./cloudflare-sfu.js', () => ({
  createCloudflareScreenApi: () => ({}),
  CloudflareScreenSession: class {
    subscribe = vi.fn(async () => {}); close = vi.fn(async () => {});
    constructor(readonly deps: typeof fake.sessions[number]['deps']) { fake.sessions.push(this); }
  }
}));
const publication = { shareId: 'share', sessionId: 'publisher', sharerIdentity: 'Ada', sharerName: 'Ada', tracks: [{ kind: 'video' as const, trackName: 'screen' }] };
const fetchIce = async () => [];
afterEach(() => { fake.sessions.length = 0; });
describe('Cloudflare receiver recovery', () => {
  it('closes the old subscriber before replacing it, caps automatic retries, and allows an explicit retry', async () => {
    const { result, unmount } = renderHook(() => useCloudflareScreen('meeting', 'Ben', fetchIce));
    act(() => result.current.announce(publication));
    await waitFor(() => expect(fake.sessions[0].subscribe).toHaveBeenCalledOnce());
    let release!: () => void;
    fake.sessions[0].close.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
    act(() => fake.sessions[0].deps.onRecoveryNeeded?.(new Error('decoder stalled')));
    await waitFor(() => expect(fake.sessions).toHaveLength(2));
    expect(fake.sessions[1].subscribe).not.toHaveBeenCalled();
    await act(async () => release());
    await waitFor(() => expect(fake.sessions[1].subscribe).toHaveBeenCalledOnce());
    act(() => fake.sessions[1].deps.onRecoveryNeeded?.(new Error('decoder stalled')));
    await waitFor(() => expect(fake.sessions[2].subscribe).toHaveBeenCalledOnce());
    act(() => fake.sessions[2].deps.onRecoveryNeeded?.(new Error('decoder stalled')));
    expect(fake.sessions).toHaveLength(3);
    expect(result.current.error).toMatch(/decoder stalled/);
    act(() => result.current.retry());
    await waitFor(() => expect(fake.sessions[3].subscribe).toHaveBeenCalledOnce());
    act(() => fake.sessions[3].deps.onRecoveryNeeded?.(new Error('decoder stalled')));
    await waitFor(() => expect(fake.sessions[4].subscribe).toHaveBeenCalledOnce());
    unmount();
  });
  it('ignores stale recovery callbacks after publication withdrawal or unmount', async () => {
    const { result, unmount } = renderHook(() => useCloudflareScreen('meeting', 'Ben', fetchIce));
    act(() => result.current.announce(publication));
    await waitFor(() => expect(fake.sessions[0].subscribe).toHaveBeenCalledOnce());
    act(() => result.current.announce(null));
    act(() => fake.sessions[0].deps.onRecoveryNeeded?.(new Error('late stall')));
    expect(fake.sessions).toHaveLength(1); expect(result.current.error).toBeUndefined();
    unmount();
    act(() => fake.sessions[0].deps.onRecoveryNeeded?.(new Error('late stall')));
    expect(fake.sessions).toHaveLength(1);
  });
});
