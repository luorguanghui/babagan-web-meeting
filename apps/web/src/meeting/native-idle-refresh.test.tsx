import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeIdleRefresh } from './native-idle-refresh.js';

class Frame {
  readonly close = vi.fn();
  readonly clones: Frame[] = [];
  constructor(readonly timestamp: number, readonly pixels: string) {}
  clone() { const copy = new Frame(this.timestamp, this.pixels); this.clones.push(copy); return copy; }
}
function setup(write = vi.fn<(frame: Frame) => Promise<unknown>>().mockResolvedValue(undefined)) {
  const canRefresh = vi.fn(() => true), refreshed = vi.fn(), fail = vi.fn();
  const created: Frame[] = [];
  const idle = new NativeIdleRefresh<Frame>({ write, canRefresh, refreshed, fail, now: () => Date.now(),
    createRefresh: (snapshot, timestamp) => { const output = new Frame(timestamp, snapshot.pixels); created.push(output); return output; } });
  return { idle, write, canRefresh, refreshed, fail, created };
}
afterEach(() => vi.useRealTimers());

describe('explicit low-frequency native media refresh', () => {
  it('retains timestamp bookkeeping before a consuming writer closes the original frame', async () => {
    const h = setup(vi.fn(async frame => { Object.defineProperty(frame, 'timestamp', { get: () => { throw new Error('consumed frame'); } }); }));
    const source = new Frame(123_000, 'picture');
    await expect(h.idle.writeOriginal(source)).resolves.toBeUndefined();
    h.idle.close();
  });
  it('emits one picture refresh by one idle second, without creating capture or original-submission counts', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const h = setup(); const source = new Frame(1_000_000, 'picture');
    h.idle.observe(source); await h.idle.writeOriginal(source);
    await vi.advanceTimersByTimeAsync(999); expect(h.created).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.created).toHaveLength(1); expect(h.created[0]).toMatchObject({ timestamp: 1_900_000, pixels: 'picture' });
    expect(h.created[0].close).toHaveBeenCalledOnce(); expect(source.close).not.toHaveBeenCalled();
    expect(h.idle.stats()).toEqual({ refreshFrames: 1 }); expect(h.refreshed).toHaveBeenCalledWith(1);
    expect(h.write.mock.calls.map(([frame]) => frame)).toEqual([source, h.created[0]]);
    h.idle.close(); expect(source.clones[0].close).toHaveBeenCalledOnce();
  });

  it('retains only the latest source snapshot and suppresses refresh while original frames continue arriving', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const h = setup(); const sources: Frame[] = [];
    for (let i = 0; i < 4; i++) {
      const source = new Frame(i * 900_000, `picture-${i}`); sources.push(source);
      h.idle.observe(source); await h.idle.writeOriginal(source); await vi.advanceTimersByTimeAsync(900);
    }
    expect(h.created).toHaveLength(0);
    for (const source of sources.slice(0, -1)) expect(source.clones[0].close).toHaveBeenCalledOnce();
    expect(sources[3].clones[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400); expect(h.created[0].pixels).toBe('picture-3');
    expect(h.created[0].timestamp).toBe(3_900_000);
    h.idle.close(); h.idle.close(); expect(sources[3].clones[0].close).toHaveBeenCalledOnce();
  });

  it('never refreshes before a source or while the original pacing queue is occupied', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const h = setup();
    await vi.advanceTimersByTimeAsync(20_000); expect(h.write).not.toHaveBeenCalled();
    h.idle.observe(new Frame(20_000_000, 'picture')); h.canRefresh.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(20_000); expect(h.write).not.toHaveBeenCalled();
    h.canRefresh.mockReturnValue(true); await vi.advanceTimersByTimeAsync(1000);
    expect(h.created).toHaveLength(1); h.idle.close();
  });

  it('serializes a new original behind one pending refresh and never overlaps writes', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let finish!: () => void;
    const write = vi.fn<(frame: Frame) => Promise<unknown>>().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const h = setup(write); const first = new Frame(0, 'first'); h.idle.observe(first);
    await vi.advanceTimersByTimeAsync(1000); expect(write).toHaveBeenCalledOnce();
    const original = new Frame(1_000_000, 'resumed'); h.idle.observe(original);
    const pending = h.idle.writeOriginal(original);
    await vi.advanceTimersByTimeAsync(20_000); expect(write).toHaveBeenCalledOnce();
    finish(); await pending; expect(write.mock.calls[1][0]).toBe(original);
    expect(h.idle.stats().refreshFrames).toBe(1); h.idle.close();
  });

  it('keeps refresh timestamps monotonic without changing actual source timestamps', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const h = setup(); const source = new Frame(500_000, 'picture');
    h.idle.observe(source); await h.idle.writeOriginal(source); await vi.advanceTimersByTimeAsync(3000);
    expect(h.created.map(frame => frame.timestamp)).toEqual([1_400_000, 2_400_000, 3_400_000]);
    expect(source.timestamp).toBe(500_000); h.idle.close();
  });

  it('closes snapshot, timer and failed refresh exactly once and reports no successful refresh on write rejection', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let reject!: (error: Error) => void;
    const h = setup(vi.fn(() => new Promise((_resolve, fail) => { reject = fail; })));
    const source = new Frame(0, 'picture'); h.idle.observe(source);
    await vi.advanceTimersByTimeAsync(1000); h.idle.close(); h.idle.close();
    expect(source.clones[0].close).toHaveBeenCalledOnce();
    reject(new Error('writer failed')); await vi.advanceTimersByTimeAsync(0);
    expect(h.created[0].close).toHaveBeenCalledOnce(); expect(h.fail).not.toHaveBeenCalled();
    expect(h.idle.stats()).toEqual({ refreshFrames: 0 }); expect(vi.getTimerCount()).toBe(0);
  });

  it('closes itself and reports a refresh write failure while active', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const h = setup(vi.fn().mockRejectedValue(new Error('refresh write failed')));
    const source = new Frame(0, 'picture'); h.idle.observe(source); await vi.advanceTimersByTimeAsync(1000);
    expect(h.fail).toHaveBeenCalledOnce(); expect(h.created[0].close).toHaveBeenCalledOnce();
    expect(source.clones[0].close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
