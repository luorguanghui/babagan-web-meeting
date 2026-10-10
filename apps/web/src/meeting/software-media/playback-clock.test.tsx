import { expect, it } from 'vitest';
import { PlaybackClock } from './playback-clock.js';
it('uses a common audio/video clock with 100ms initial buffer', () => {
  const clock = new PlaybackClock();
  clock.anchor(1000000, 2000);
  expect(clock.dueAt(1000000)).toBe(2100);
  expect(clock.dueAt(1020000)).toBe(2120);
  expect(clock.dueAt(1033333)).toBeCloseTo(2133.333);
});
it('resets a new generation and bounds late recovery without replaying old audio', () => {
  const clock = new PlaybackClock();
  clock.anchor(1000000, 2000);
  clock.reset(); clock.anchor(3000000, 5000);
  expect(clock.dueAt(3000000)).toBe(5100);
  expect(clock.isLate(3000000, 5301)).toBe(true);
});
