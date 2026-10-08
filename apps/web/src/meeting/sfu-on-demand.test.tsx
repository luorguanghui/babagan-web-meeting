import { describe, expect, it, vi } from 'vitest';
import { HybridScreenSharePublisher } from './screen-share.js';
import type { P2pShareController } from './p2p-share-controller.js';

const stream = {} as MediaStream;
const options = { maxBitrate: 8_000_000, frameRate: 30, degradationPreference: 'maintain-resolution' as const, codec: 'h264' as const };
function fixture() {
  const publish = vi.fn(async () => undefined), release = vi.fn(async () => undefined);
  const start = vi.fn(async () => undefined), stop = vi.fn(async () => undefined), left = vi.fn(), retry = vi.fn();
  let viewers = [{ identity: 'a', nickname: 'A' }, { identity: 'b', nickname: 'B' }];
  const controller = { start, stop, handleViewerLeft: left, handleRetry: retry, subscribe: () => () => {}, getViewerStates: () => new Map() } as unknown as P2pShareController;
  const hybrid = new HybridScreenSharePublisher({ sfuPublisher: { publish, release }, getViewers: () => viewers, createShareController: () => controller });
  return { hybrid, publish, release, start, stop, left, retry, removeViewer: (identity: string) => { viewers = viewers.filter((viewer) => viewer.identity !== identity); hybrid.viewerLeft(identity); } };
}
describe('explicit SFU demand', () => {
  it('starts P2P without publishing a backup stream', async () => {
    const f = fixture(); await f.hybrid.publish(stream, options);
    expect(f.start).toHaveBeenCalledOnce(); expect(f.publish).not.toHaveBeenCalled();
  });
  it('publishes only after an explicit choice and stops after the last SFU viewer returns', async () => {
    const f = fixture(); await f.hybrid.publish(stream, options);
    await f.hybrid.setViewerScreenTransport('a', 'sfu');
    await f.hybrid.setViewerScreenTransport('b', 'sfu');
    expect(f.publish).toHaveBeenCalledOnce();
    await f.hybrid.setViewerScreenTransport('a', 'peer'); expect(f.release).not.toHaveBeenCalled();
    await f.hybrid.setViewerScreenTransport('b', 'peer'); expect(f.release).toHaveBeenCalledOnce();
  });
  it('releases SFU when its last viewer leaves', async () => {
    const f = fixture(); await f.hybrid.publish(stream, options);
    await f.hybrid.setViewerScreenTransport('a', 'sfu'); f.hybrid.viewerLeft('a');
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    expect(f.left).toHaveBeenCalledWith('a');
  });
  it('cleans up a publish that completes after sharing stopped', async () => {
    const f = fixture(); await f.hybrid.publish(stream, options);
    let complete!: () => void;
    f.publish.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    const requested = f.hybrid.setViewerScreenTransport('a', 'sfu');
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
    const stopped = f.hybrid.release(stream); complete(); await Promise.all([requested, stopped]);
    expect(f.release).toHaveBeenCalledOnce();
    await f.hybrid.setViewerScreenTransport('a', 'sfu'); expect(f.publish).toHaveBeenCalledOnce();
  });
  it('does not create SFU just because P2P failed to start', async () => {
    const f = fixture(); f.start.mockRejectedValueOnce(new Error('ICE temporarily unavailable'));
    await f.hybrid.publish(stream, options); expect(f.publish).not.toHaveBeenCalled();
  });
  it('does not revive a departed viewer when a pending peer selection finishes', async () => {
    const f = fixture(); await f.hybrid.publish(stream, options);
    await f.hybrid.setViewerScreenTransport('a', 'sfu');
    let finish!: () => void;
    f.release.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = f.hybrid.setViewerScreenTransport('a', 'peer');
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    f.removeViewer('a'); finish(); await pending;
    expect(f.retry).not.toHaveBeenCalled();
  });
  it('does not act on a stale peer choice after a newer SFU selection', async () => {
    const f = fixture(); await f.hybrid.publish(stream, options);
    await f.hybrid.setViewerScreenTransport('a', 'sfu');
    let finish!: () => void;
    f.release.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = f.hybrid.setViewerScreenTransport('a', 'peer');
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    const latest = f.hybrid.setViewerScreenTransport('a', 'sfu'); finish();
    await Promise.all([pending, latest]); expect(f.retry).not.toHaveBeenCalled();
  });
});
