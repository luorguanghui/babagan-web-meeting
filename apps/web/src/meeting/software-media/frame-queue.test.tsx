import { expect, it } from 'vitest';
import { FrameQueue } from './frame-queue.js';
function frame(id: number) { return { id, closes: 0, close() { this.closes++; } }; }
it('closes the oldest raw frame when six pending frames are full', () => {
  const queue = new FrameQueue<ReturnType<typeof frame>>();
  const frames = Array.from({ length: 7 }, (_, id) => frame(id));
  frames.forEach(value => queue.push(value, 0));
  expect(queue.length).toBe(6);
  expect(frames[0].closes).toBe(1);
  expect(queue.take(10)?.frame.id).toBe(1);
  queue.clear();
  expect(frames.slice(2).every(value => value.closes === 1)).toBe(true);
});
it('expires old raw frames and releases all owned resources exactly once on stop', () => {
  const queue = new FrameQueue<ReturnType<typeof frame>>();
  const old = frame(1), current = frame(2);
  queue.push(old, 0); queue.push(current, 130);
  expect(queue.take(151)?.frame).toBe(current);
  expect(old.closes).toBe(1);
  current.close();
  queue.clear(); queue.clear();
  expect(current.closes).toBe(1);
  expect(queue.expiredDrops).toBe(1);
});
