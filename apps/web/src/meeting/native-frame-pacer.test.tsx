import { afterEach, expect, it, vi } from 'vitest';
import { NativeFramePacer } from './native-frame-pacer.js';
afterEach(() => vi.useRealTimers());
function frame(timestamp: number) { return { timestamp, close: vi.fn() }; }

it('smooths packet arrival jitter using original timestamps without duplicating frames', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const delivered: Array<{ frame: ReturnType<typeof frame>; at: number }> = [];
  const pacer = new NativeFramePacer<ReturnType<typeof frame>>({ frameRate: 60, now: () => Date.now(),
    deliver: value => { delivered.push({ frame: value, at: Date.now() }); }, fail: vi.fn() });
  const frames = [frame(0), frame(16667), frame(33333), frame(50000)];
  pacer.push(frames[0]); await vi.advanceTimersByTimeAsync(8); pacer.push(frames[1]);
  await vi.advanceTimersByTimeAsync(23); pacer.push(frames[2]);
  await vi.advanceTimersByTimeAsync(19); pacer.push(frames[3]);
  await vi.advanceTimersByTimeAsync(100);
  expect(delivered.map(item => item.frame)).toEqual(frames);
  expect(delivered.map(item => item.at)).toEqual([40, 57, 74, 90]);
  for (const value of frames) expect(value.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000); expect(delivered).toHaveLength(4);
  pacer.close();
});
it('bounds queued frames and releases overflow and cancelled frames', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0); const deliver = vi.fn();
  const pacer = new NativeFramePacer<ReturnType<typeof frame>>({ frameRate: 60, now: () => Date.now(), deliver, fail: vi.fn() });
  const frames = Array.from({ length: 8 }, (_, index) => frame(index * 16667)); frames.forEach(value => pacer.push(value));
  expect(pacer.stats().queuedFrames).toBeLessThanOrEqual(4);
  expect(pacer.stats().droppedFrames).toBe(4); pacer.close();
  await vi.advanceTimersByTimeAsync(500);
  expect(deliver).not.toHaveBeenCalled(); for (const value of frames) expect(value.close).toHaveBeenCalledOnce();
});
it('does not overlap pending writes, and closes a frame even when the write fails', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let reject!: (error: Error) => void; const fail = vi.fn();
  const deliver = vi.fn(() => new Promise<void>((_resolve, rejectWrite) => { reject = rejectWrite; }));
  const pacer = new NativeFramePacer<ReturnType<typeof frame>>({ frameRate: 60, now: () => Date.now(), deliver, fail });
  const first = frame(0), second = frame(16667); pacer.push(first); pacer.push(second);
  await vi.advanceTimersByTimeAsync(100); expect(deliver).toHaveBeenCalledOnce();
  reject(new Error('writer stopped')); await vi.advanceTimersByTimeAsync(0);
  expect(fail).toHaveBeenCalledOnce(); expect(first.close).toHaveBeenCalledOnce(); pacer.close();
  expect(second.close).toHaveBeenCalledOnce();
});
it('resumes after a long source gap without inventing catch-up frames', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0); const deliver = vi.fn();
  const pacer = new NativeFramePacer<ReturnType<typeof frame>>({ frameRate: 60, now: () => Date.now(), deliver, fail: vi.fn() });
  pacer.push(frame(0)); await vi.advanceTimersByTimeAsync(5000);
  expect(deliver).toHaveBeenCalledOnce(); pacer.push(frame(5_000_000)); await vi.advanceTimersByTimeAsync(100);
  expect(deliver).toHaveBeenCalledTimes(2); pacer.close();
});
it('keeps making progress after a blocked first delivery and a continuously full input queue', async () => {
  vi.useFakeTimers(); let clock = 0; const deliver = vi.fn();
  const pacer = new NativeFramePacer<ReturnType<typeof frame>>({ frameRate: 60, now: () => clock, deliver, fail: vi.fn() });
  pacer.push(frame(0)); clock = 120; await vi.advanceTimersByTimeAsync(40);
  for (let index = 1; index < 8; index++) pacer.push(frame(index * 16667));
  for (let index = 8; index < 24; index++) {
    clock = index * 1000 / 60; pacer.push(frame(index * 16667)); await vi.advanceTimersByTimeAsync(1000 / 60);
  }
  expect(deliver.mock.calls.length).toBeGreaterThan(8);
  expect(pacer.stats().queuedFrames).toBeLessThanOrEqual(4); pacer.close();
});

it('does not accumulate recurring scheduler lateness into a slower capture clock', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0); const delivered: ReturnType<typeof frame>[] = [];
  const pacer = new NativeFramePacer<ReturnType<typeof frame>>({ frameRate: 60, now: () => Date.now(),
    schedule: (callback, delay) => { const timer = setTimeout(callback, delay + 9); return () => clearTimeout(timer); },
    deliver: value => { delivered.push(value); }, fail: vi.fn() });
  const frames = Array.from({ length: 120 }, (_, index) => frame(Math.round(index * 1_000_000 / 60)));
  for (const value of frames) { pacer.push(value); await vi.advanceTimersByTimeAsync(1000 / 60); }
  await vi.advanceTimersByTimeAsync(200);
  expect(delivered).toEqual(frames);
  expect(pacer.stats().droppedFrames).toBe(0); pacer.close();
});
