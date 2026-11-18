import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoqScreenPublisher } from './screen-moq.js';
import type { ScreenSharePublishOptions } from './screen-share.js';

const connection = { shareId: 'test-share', namespace: 'screen', url: 'https://draft-18.cloudflare.mediaoverquic.com/test-token' };
const options: ScreenSharePublishOptions = { maxBitrate: 5_000_000, frameRate: 30, codec: 'h264', degradationPreference: 'maintain-framerate' };
const stream = {} as MediaStream;

function setup() {
  let disconnect!: () => void;
  const media = { close: vi.fn(), closed: new Promise<void>(resolve => { disconnect = resolve; }) };
  const api = { publish: vi.fn(async () => connection), ready: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const open = vi.fn(async () => media);
  const failed = vi.fn();
  return { api, disconnect, media, open, failed, publisher: new MoqScreenPublisher(api, open, failed) };
}

afterEach(() => vi.useRealTimers());

describe('MoQ screen publication', () => {
  it('announces only after media is ready, renews the lease and removes it once on stop', async () => {
    vi.useFakeTimers();
    const f = setup();
    await f.publisher.start(stream, options);
    expect(f.open).toHaveBeenCalledWith(connection, stream, options, expect.any(AbortSignal));
    expect(f.api.ready).toHaveBeenCalledWith(connection.shareId, expect.any(AbortSignal));
    expect(f.api.ready.mock.invocationCallOrder[0]).toBeGreaterThan(f.open.mock.invocationCallOrder[0]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(f.api.ready).toHaveBeenCalledTimes(2);

    await Promise.all([f.publisher.close(), f.publisher.close()]);
    f.disconnect();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.media.close).toHaveBeenCalledOnce();
    expect(f.api.stop).toHaveBeenCalledExactlyOnceWith(connection.shareId);
    expect(f.api.ready).toHaveBeenCalledTimes(2);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('releases a relay when opening the media fails', async () => {
    const f = setup();
    f.open.mockRejectedValueOnce(new Error('transport down'));
    await expect(f.publisher.start(stream, options)).rejects.toThrow('transport down');
    expect(f.api.ready).not.toHaveBeenCalled();
    expect(f.api.stop).toHaveBeenCalledExactlyOnceWith(connection.shareId);
  });

  it('releases the publication and reports a media disconnection', async () => {
    const f = setup();
    await f.publisher.start(stream, options);
    f.disconnect();
    await vi.waitFor(() => expect(f.failed).toHaveBeenCalledOnce());
    expect(f.api.stop).toHaveBeenCalledExactlyOnceWith(connection.shareId);
  });
});
