import { expect, it } from 'vitest';
import { FrameRateLimiter } from './frame-rate.js';

it('preserves 30fps input with capture jitter instead of repeatedly dropping every other frame', () => {
  const limiter = new FrameRateLimiter(30);
  const timestamps = Array.from({ length: 300 }, (_, index) => index * 1000000 / 30 + (index % 2 ? -1000 : 1000));
  expect(timestamps.filter(timestamp => limiter.accept(timestamp)).length).toBeGreaterThanOrEqual(299);
});
it('limits faster input by an accumulated deadline and recovers after a pause', () => {
  const limiter = new FrameRateLimiter(60);
  const accepted = Array.from({ length: 1000 }, (_, index) => index * 1000).filter(timestamp => limiter.accept(timestamp));
  expect(accepted.length).toBeGreaterThanOrEqual(60);
  expect(accepted.length).toBeLessThanOrEqual(61);
  expect(limiter.accept(5000000)).toBe(true);
  expect(limiter.accept(5001000)).toBe(false);
});
