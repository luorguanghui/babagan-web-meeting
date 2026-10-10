import { expect, it } from 'vitest';
import { StatsSampler } from './stats-sampler.js';
import { emptyStats } from './encoder.js';
it('derives actual fps and bitrate from counter deltas, not configured frame rate', () => {
  let now = 0;
  const sample = new StatsSampler(() => now);
  sample.sample(emptyStats());
  now = 1000;
  const stats = sample.sample({ ...emptyStats(), rawFrames: 60, encodedFrames: 44, encodedBytes: 1000000, decodedFrames: 43 });
  expect(stats.encodedFps).toBe(44);
  expect(stats.decodedFps).toBe(43);
  expect(stats.encodedBps).toBe(8000000);
  now = 1001;
  expect(sample.sample({ ...stats }).encodedFps).toBe(44);
});
