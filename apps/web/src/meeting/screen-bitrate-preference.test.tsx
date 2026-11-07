import { afterEach, expect, it } from 'vitest';
import { readScreenBitrate, saveScreenBitrate } from './screen-bitrate-preference.js';
afterEach(() => localStorage.removeItem('babagan.screen-bitrate-cap'));
it('defaults to 10 Mbps and preserves an explicitly selected ceiling', () => {
  expect(readScreenBitrate()).toBe(10_000_000);
  saveScreenBitrate(5_000_000); expect(readScreenBitrate()).toBe(5_000_000);
  localStorage.setItem('babagan.screen-bitrate-cap', 'Infinity'); expect(readScreenBitrate()).toBe(10_000_000);
});
