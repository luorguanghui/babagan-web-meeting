import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client.js';
import { CloudflareScreenRecovery } from './cloudflare-recovery.js';

const publication = { shareId: 'share', sessionId: 'pub', sharerIdentity: 'Ada', sharerName: 'Ada', tracks: [{ kind: 'video' as const, trackName: 'screen' }] };
function setup(failure?: Error) {
  const sessions: Array<ReturnType<typeof make>> = [];
  const make = (onStream: (s: MediaStream) => void, onError: (e: unknown) => void) => ({
    onStream, onError, publish: vi.fn(async () => { if (failure) throw failure; }), subscribe: vi.fn(async () => {}),
    close: vi.fn(async () => {}), getStatsReport: vi.fn(async () => undefined)
  });
  const recovering = vi.fn(); const stream = vi.fn(); const error = vi.fn();
  const recovery = new CloudflareScreenRecovery({
    createSession: (s, e) => { const session = make(s, e); sessions.push(session); return session; },
    onStream: stream, onError: error, onRecovering: recovering
  });
  return { recovery, sessions, recovering, stream, error };
}
afterEach(() => vi.useRealTimers());
describe('Cloudflare automatic recovery', () => {
  it('backs off repeated transient publish failures to a ten-second ceiling', async () => {
    vi.useFakeTimers(); const f = setup(new ApiRequestError('unavailable', 503));
    await f.recovery.publish({} as MediaStream, { codec: 'h264', maxBitrate: 8000000, frameRate: 60, degradationPreference: 'maintain-resolution' });
    let count = 1;
    for (const delay of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
      await vi.advanceTimersByTimeAsync(delay - 1); expect(f.sessions).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1); expect(f.sessions).toHaveLength(++count);
    }
    await f.recovery.close();
  });
  it('rejects an initially forbidden publish so the capture controller releases the share', async () => {
    vi.useFakeTimers(); const f = setup(new ApiRequestError('revoked', 403));
    await expect(f.recovery.publish({} as MediaStream, { codec: 'h264', maxBitrate: 8000000, frameRate: 60, degradationPreference: 'maintain-resolution' })).rejects.toThrow('revoked');
    await f.recovery.close(); await vi.advanceTimersByTimeAsync(60000);
    expect(f.sessions).toHaveLength(1);
  });
  it('starts fallback immediately, serializes cleanup, retries automatically and ignores stale callbacks', async () => {
    vi.useFakeTimers(); const f = setup(); await f.recovery.subscribe(publication);
    f.sessions[0].onStream({} as MediaStream);
    let release!: () => void;
    f.sessions[0].close.mockImplementation(() => new Promise<void>(r => { release = r; }));
    f.sessions[0].onError(new Error('lost')); f.sessions[0].onError(new Error('lost again'));
    expect(f.recovering).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(500); expect(f.sessions).toHaveLength(1);
    release(); await vi.advanceTimersByTimeAsync(0); expect(f.sessions).toHaveLength(2);
    expect(f.sessions[0].close).toHaveBeenCalledOnce();
    const shown = {} as MediaStream; f.sessions[1].onStream(shown);
    expect(f.stream).toHaveBeenLastCalledWith(shown); expect(f.recovering).toHaveBeenLastCalledWith(false);
    f.sessions[0].onError(new Error('late')); f.sessions[0].onStream({} as MediaStream);
    await vi.advanceTimersByTimeAsync(1000); expect(f.sessions).toHaveLength(2);
    expect(f.stream).toHaveBeenLastCalledWith(shown); await f.recovery.close();
  });
  it('retries a connected receiver that never receives video, with capped backoff', async () => {
    vi.useFakeTimers(); const f = setup(); await f.recovery.subscribe(publication);
    await vi.advanceTimersByTimeAsync(12000); expect(f.recovering).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(500); expect(f.sessions).toHaveLength(2);
    f.sessions[1].onError(new Error('lost'));
    await vi.advanceTimersByTimeAsync(999); expect(f.sessions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(f.sessions).toHaveLength(3);
    await f.recovery.close(); await vi.advanceTimersByTimeAsync(60000); expect(f.sessions).toHaveLength(3);
  });
  it('keeps initial transient publish failures recoverable and stops on authorization failure', async () => {
    vi.useFakeTimers(); const f = setup();
    // The callback can fire before the negotiation promise settles.
    const started = f.recovery.publish({} as MediaStream, { codec: 'h264', maxBitrate: 8000000, frameRate: 60, degradationPreference: 'maintain-resolution' });
    f.sessions[0].onError(new Error('lost'));
    await started; expect(f.recovering).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(500); expect(f.sessions).toHaveLength(2);
    expect(f.recovering).toHaveBeenLastCalledWith(false);
    f.sessions[1].onError(new ApiRequestError('revoked', 403));
    await vi.advanceTimersByTimeAsync(60000); expect(f.sessions).toHaveLength(2);
    await f.recovery.close();
  });
  it('does not allocate again if stopped during slow cleanup', async () => {
    vi.useFakeTimers(); const f = setup(); await f.recovery.subscribe(publication);
    let release!: () => void;
    f.sessions[0].close.mockImplementation(() => new Promise<void>(r => { release = r; }));
    f.sessions[0].onError(new Error('lost')); await vi.advanceTimersByTimeAsync(500);
    const stopped = f.recovery.close(); release(); await stopped;
    await vi.advanceTimersByTimeAsync(60000); expect(f.sessions).toHaveLength(1);
  });
});
