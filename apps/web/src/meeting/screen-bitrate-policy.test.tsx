import { describe, expect, it } from 'vitest';
import { recommendP2pBitrate } from './screen-share.js';

describe('screen bitrate guidance', () => {
  it.each(['motion', 'detail60'] as const)('provides headroom for %s with one or two viewers', quality => {
    expect(recommendP2pBitrate(1, quality)).toBe(20_000_000);
    expect(recommendP2pBitrate(2, quality)).toBe(20_000_000);
  });
  it('keeps four 60fps peer uploads within the aggregate uplink budget', () => {
    expect(recommendP2pBitrate(4, 'motion')).toBe(10_000_000);
    expect(recommendP2pBitrate(3, 'motion')).toBe(10_000_000);
  });
  it('retains the existing 30fps defaults', () => {
    expect(recommendP2pBitrate(1, 'standard')).toBe(8_000_000);
    expect(recommendP2pBitrate(4, 'flow')).toBe(5_000_000);
  });
});
