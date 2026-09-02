import { describe, expect, it } from 'vitest';

import {
  updateCloudflareEncoding,
  type CloudflareEncodingState
} from './cloudflare-adaptive-encoding.js';

const initialState: CloudflareEncodingState = {
  targetBitrateBps: 8_000_000,
  scaleResolutionDownBy: 1
};

describe('Cloudflare TURN adaptive encoding', () => {
  it('raises the target bitrate toward a fast relay connection', () => {
    const next = updateCloudflareEncoding({
      previous: initialState,
      measurement: { availableOutgoingBitrateBps: 30_000_000, actualOutgoingBitrateBps: 8_000_000 },
      minimumScaleResolutionDownBy: 1
    });

    expect(next.bandwidthEstimateBps).toBe(30_000_000);
    expect(next.targetBitrateBps).toBe(11_500_000);
    expect(next.scaleResolutionDownBy).toBe(1);
  });

  it('changes the resolution scale gradually under a slow relay connection', () => {
    const measurement = { availableOutgoingBitrateBps: 4_000_000, actualOutgoingBitrateBps: 8_000_000 };
    const first = updateCloudflareEncoding({
      previous: initialState,
      measurement,
      minimumScaleResolutionDownBy: 1
    });
    const second = updateCloudflareEncoding({
      previous: first,
      measurement,
      minimumScaleResolutionDownBy: 1
    });

    expect(first.targetBitrateBps).toBe(7_080_000);
    expect(first.scaleResolutionDownBy).toBeCloseTo(1.1, 5);
    expect(second.scaleResolutionDownBy).toBeCloseTo(1.21, 5);
    expect(second.scaleResolutionDownBy).not.toBe(2);
  });

  it('can exceed the old 40 Mbps aggregate budget on a fast Cloudflare path', () => {
    const next = updateCloudflareEncoding({
      previous: {
        targetBitrateBps: 40_000_000,
        scaleResolutionDownBy: 1
      },
      measurement: { availableOutgoingBitrateBps: 60_000_000, actualOutgoingBitrateBps: 40_000_000 },
      minimumScaleResolutionDownBy: 1
    });

    expect(next.targetBitrateBps).toBeGreaterThan(40_000_000);
  });

  it('holds the previous state when the connection exposes no usable rate', () => {
    expect(updateCloudflareEncoding({
      previous: initialState,
      measurement: {},
      minimumScaleResolutionDownBy: 1
    })).toEqual(initialState);
  });
});
