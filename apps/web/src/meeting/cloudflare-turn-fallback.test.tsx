import { describe, expect, it, vi } from 'vitest';
import { CloudflareTurnFallback } from './cloudflare-turn-fallback.js';
import type { P2pShareController } from './p2p-share-controller.js';

function setup() {
  const share = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), handleViewerLeft: vi.fn(), getViewerStates: () => new Map(), handleRetry: vi.fn() };
  const create = vi.fn(() => share as unknown as P2pShareController);
  const fallback = new CloudflareTurnFallback({ stream: {} as MediaStream, options: { codec: 'h264', maxBitrate: 8000000, frameRate: 60, degradationPreference: 'maintain-resolution' }, createController: create });
  return { fallback, create, share };
}
describe('on-demand Cloudflare TURN fallback', () => {
  it('allocates only on demand and stops each relay when that viewer renders SFU', async () => {
    const f = setup(); expect(f.create).not.toHaveBeenCalled();
    await f.fallback.request('Ben'); await f.fallback.request('Ben');
    expect(f.share.start).toHaveBeenCalledOnce();
    await f.fallback.request('Carla'); expect(f.share.start).toHaveBeenCalledTimes(2);
    f.fallback.release('Ben'); expect(f.share.handleViewerLeft).toHaveBeenCalledWith('Ben');
    expect(f.share.stop).not.toHaveBeenCalled(); await f.fallback.close(); expect(f.share.stop).toHaveBeenCalled();
  });
  it('does not start queued viewers after stop or retain a withdrawn slow request', async () => {
    const f = setup(); let release!: () => void;
    f.share.start.mockImplementation(() => new Promise<void>(r => { release = r; }));
    const first = f.fallback.request('Ben'); await Promise.resolve();
    const second = f.fallback.request('Carla'); const closed = f.fallback.close();
    release(); await Promise.all([first, second, closed]);
    expect(f.share.start).toHaveBeenCalledOnce(); expect(f.share.handleViewerLeft).toHaveBeenCalledWith('Ben');
    await f.fallback.request('Dan'); expect(f.share.start).toHaveBeenCalledOnce();
  });
});
