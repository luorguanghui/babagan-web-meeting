import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeWorkerPacer, NativeFrameWorkerRuntime, localNativePacer } from './worker-pacer.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function frame(timestamp: number): VideoFrame {
  return { timestamp, close: vi.fn(), clone: vi.fn(() => frame(timestamp)) } as unknown as VideoFrame;
}
function fakeVideoFrames() {
  vi.stubGlobal('VideoFrame', class {
    readonly timestamp: number; readonly close = vi.fn();
    constructor(_snapshot: VideoFrame, init: { timestamp: number }) { this.timestamp = init.timestamp; }
    clone() { return frame(this.timestamp); }
  });
}
class WorkerPort extends EventTarget {
  postMessage = vi.fn<(message: { type: string; id?: number; [key: string]: unknown }, transfers?: unknown[]) => void>();
  terminate = vi.fn();
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
function setup() {
  const worker = new WorkerPort(), delivered = vi.fn(), fail = vi.fn();
  const pacer = new NativeWorkerPacer(worker as unknown as Worker, {} as WritableStream<VideoFrame>, {
    frameRate: 60, delivered, fail, control: new Int32Array(new SharedArrayBuffer(4))
  });
  worker.message({ type: 'ready' });
  return { pacer, worker, delivered, fail };
}

describe('main-to-worker frame ownership', () => {
  it('counts actual received frames even when transfer drops occur, while refresh replies never count as source delivery', async () => {
    const h = setup(); await h.pacer.ready;
    for (let i = 0; i < 5; i++) h.pacer.push(frame(i * 16667));
    h.worker.message({ type: 'refresh', refreshFrames: 3 });
    expect(h.pacer.stats()).toMatchObject({ receivedFrames: 5, submittedFrames: 0, refreshFrames: 3, droppedFrames: 1 });
    expect(h.delivered).not.toHaveBeenCalled();
    const closing = h.pacer.close(); h.worker.message({ type: 'stopped' }); await closing;
    h.pacer.push(frame(100_000)); expect(h.pacer.stats().receivedFrames).toBe(5);
  });
  it('bounds outstanding transfers to four, releases overflow, and returns credit only for an acknowledged id', async () => {
    const h = setup(); await h.pacer.ready;
    const frames = Array.from({ length: 6 }, (_, index) => frame(index * 16667)); frames.forEach(value => h.pacer.push(value));
    const sent = h.worker.postMessage.mock.calls.filter(([message]) => message.type === 'frame');
    expect(sent).toHaveLength(4); expect(frames[4].close).toHaveBeenCalledOnce(); expect(frames[5].close).toHaveBeenCalledOnce();
    expect(sent.map(([message]) => (message.frame as VideoFrame).timestamp)).toEqual([0, 16667, 33334, 50001]);
    h.worker.message({ type: 'ack', id: sent[0][0].id, stats: { queuedFrames: 1, submittedFrames: 0, droppedFrames: 0 } });
    h.worker.message({ type: 'ack', id: sent[0][0].id });
    const next = frame(100002), overflow = frame(116669); h.pacer.push(next); h.pacer.push(overflow);
    expect(overflow.close).toHaveBeenCalledOnce(); expect(h.pacer.stats()).toMatchObject({ inFlightFrames: 4, droppedFrames: 3 });
    const closing = h.pacer.close(); h.worker.message({ type: 'stopped' }); await closing;
  });

  it('resolves first-frame notification only after a write completes and ignores late delivery after stopping', async () => {
    const h = setup(); await h.pacer.ready;
    h.pacer.push(frame(0)); h.worker.message({ type: 'ack', id: 1 }); expect(h.delivered).not.toHaveBeenCalled();
    h.worker.message({ type: 'delivered', stats: { queuedFrames: 0, submittedFrames: 1, droppedFrames: 0 } });
    expect(h.delivered).toHaveBeenCalledOnce(); const closing = h.pacer.close();
    h.worker.message({ type: 'delivered', stats: { queuedFrames: 0, submittedFrames: 2, droppedFrames: 0 } });
    h.worker.message({ type: 'stopped' }); await closing;
    expect(h.delivered).toHaveBeenCalledOnce(); expect(h.worker.terminate).toHaveBeenCalledOnce();
  });

  it('interrupts worker waits and terminates within a bounded time even without a stop acknowledgement', async () => {
    vi.useFakeTimers(); const h = setup(); await h.pacer.ready;
    const control = h.worker.postMessage.mock.calls[0][0].control as Int32Array;
    const first = h.pacer.close(), second = h.pacer.close();
    expect(Atomics.load(control, 0)).toBe(1); expect(h.worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250); await Promise.all([first, second]);
    expect(h.worker.terminate).toHaveBeenCalledOnce();
    const late = frame(0); h.pacer.push(late); expect(late.close).toHaveBeenCalledOnce();
  });

  it('rejects initialization on timeout and reports runtime errors instead of leaving a silent frozen track', async () => {
    vi.useFakeTimers(); const worker = new WorkerPort();
    const startup = new NativeWorkerPacer(worker as unknown as Worker, {} as WritableStream<VideoFrame>, {
      frameRate: 60, delivered: vi.fn(), fail: vi.fn(), control: new Int32Array(new SharedArrayBuffer(4))
    });
    const failed = startup.ready.catch(error => error); await vi.advanceTimersByTimeAsync(2000);
    expect(await failed).toMatchObject({ message: expect.stringContaining('initialization timed out') });
    worker.message({ type: 'stopped' });
    const h = setup(); await h.pacer.ready; h.worker.dispatchEvent(new Event('error'));
    expect(h.fail).toHaveBeenCalledOnce(); h.worker.message({ type: 'stopped' });
  });

  it('reports an unsolicited worker stop instead of leaving a live track frozen', async () => {
    const h = setup(); await h.pacer.ready;
    h.worker.message({ type: 'stopped' });
    expect(h.fail).toHaveBeenCalledOnce(); expect(h.worker.terminate).toHaveBeenCalledOnce();
    const late = frame(1000); h.pacer.push(late); expect(late.close).toHaveBeenCalledOnce();
  });

  it('reclaims a frame whose transfer fails and reports the delivery failure once', async () => {
    const h = setup(); await h.pacer.ready;
    h.worker.postMessage.mockImplementationOnce(() => { throw new DOMException('frame transfer failed', 'DataCloneError'); });
    const failed = frame(1000); h.pacer.push(failed);
    expect(failed.close).toHaveBeenCalledOnce(); expect(h.fail).toHaveBeenCalledOnce();
    h.worker.message({ type: 'error', message: 'late error' }); expect(h.fail).toHaveBeenCalledOnce();
    h.worker.message({ type: 'stopped' });
  });
});

describe('worker-owned frame pacing', () => {
  it('sends a separately counted idle refresh within one second after a single actual source frame, without source-delivered notifications', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); fakeVideoFrames();
    const post = vi.fn(), write = vi.fn<(frame: VideoFrame) => Promise<void>>().mockResolvedValue(undefined), close = vi.fn(async () => {});
    const worker = new NativeFrameWorkerRuntime(post, { now: () => Date.now() });
    worker.handle({ type: 'init', frameRate: 60, writable: { getWriter: () => ({ write, close }) } as unknown as WritableStream<VideoFrame> });
    const original = frame(2_000_000); worker.handle({ type: 'frame', id: 1, frame: original });
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(2); expect(write.mock.calls[0][0]).toBe(original);
    expect(write.mock.calls[1][0].timestamp).toBe(2_900_000);
    expect(post.mock.calls.filter(([message]) => message.type === 'delivered')).toHaveLength(1);
    expect(post).toHaveBeenCalledWith({ type: 'refresh', refreshFrames: 1 });
    const delivered = post.mock.calls.find(([message]) => message.type === 'delivered')![0];
    expect(delivered.stats.submittedFrames).toBe(1);
    worker.handle({ type: 'stop' }); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0); expect(close).toHaveBeenCalledOnce();
    expect((original.clone as ReturnType<typeof vi.fn>).mock.results[0].value.close).toHaveBeenCalledOnce();
  });

  it('keeps local refresh and incoming-source counts separate and cleans up a failed refresh write', async () => {
    vi.useFakeTimers(); fakeVideoFrames();
    const write = vi.fn<(frame: VideoFrame) => Promise<unknown>>().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('refresh failed'));
    const close = vi.fn(async () => {}), delivered = vi.fn(), fail = vi.fn();
    const pacer = localNativePacer({ write, close }, { frameRate: 60, delivered, fail }, 'Test fallback');
    const original = frame(0); pacer.push(original);
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(2); expect(fail).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(delivered).toHaveBeenCalledOnce();
    expect(pacer.stats()).toMatchObject({ receivedFrames: 1, submittedFrames: 1, refreshFrames: 0 });
    expect(write.mock.calls[1][0].close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    await pacer.close(); expect(close).toHaveBeenCalledOnce();
  });
  it('writes each original at its cadence in the worker and closes queued frames and the writer on stop', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const posted: Array<{ type: string; [key: string]: unknown }> = [], write = vi.fn<(frame: VideoFrame) => Promise<void>>(async () => {}), close = vi.fn(async () => {});
    const worker = new NativeFrameWorkerRuntime(message => posted.push(message), { now: () => Date.now() });
    worker.handle({ type: 'init', frameRate: 60, writable: { getWriter: () => ({ write, close }) } as unknown as WritableStream<VideoFrame> });
    const frames = [frame(1000), frame(17667), frame(34333)];
    frames.forEach((value, index) => worker.handle({ type: 'frame', id: index + 1, frame: value }));
    expect(posted.filter(message => message.type === 'ack')).toHaveLength(3); expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(58);
    expect(write.mock.calls.map(args => args[0])).toEqual(frames.slice(0, 2));
    expect(posted.filter(message => message.type === 'delivered')).toHaveLength(2);
    worker.handle({ type: 'stop' }); await vi.advanceTimersByTimeAsync(0);
    for (const value of frames) expect(value.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce(); expect(posted.at(-1)?.type).toBe('stopped');
  });

  it('bounds the worker queue and releases every transferred frame on failed writes', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const post = vi.fn(), close = vi.fn(async () => {}), write = vi.fn(async () => { throw new Error('writer failed'); });
    const worker = new NativeFrameWorkerRuntime(post, { now: () => Date.now() });
    worker.handle({ type: 'init', frameRate: 60, writable: { getWriter: () => ({ write, close }) } as unknown as WritableStream<VideoFrame> });
    const frames = Array.from({ length: 8 }, (_, index) => frame(index * 16667));
    frames.forEach((value, index) => worker.handle({ type: 'frame', id: index, frame: value }));
    expect(post.mock.calls.at(-1)?.[0].stats).toMatchObject({ queuedFrames: 4, droppedFrames: 4 });
    await vi.advanceTimersByTimeAsync(100);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('writer failed') }));
    for (const value of frames) expect(value.close).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
});
