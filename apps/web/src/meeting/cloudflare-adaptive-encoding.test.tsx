import { describe, expect, it } from 'vitest';

import {
  computeCloudflareMaximumScale,
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

  it('keeps a 1728x1080 source from falling below a 720p short side', () => {
    let state = initialState;
    for (let sample = 0; sample < 40; sample += 1) {
      state = updateCloudflareEncoding({
        previous: state,
        measurement: { availableOutgoingBitrateBps: 500_000, actualOutgoingBitrateBps: 8_000_000 },
        minimumScaleResolutionDownBy: 1,
        maximumScaleResolutionDownBy: 1.5,
        referenceBitrateBps: 8_000_000
      });
    }

    expect(state.scaleResolutionDownBy).toBeLessThanOrEqual(1.5);
    expect(1080 / state.scaleResolutionDownBy).toBeGreaterThanOrEqual(720);
  });

  it('derives a 720p floor from the source short side', () => {
    expect(computeCloudflareMaximumScale({ width: 1728, height: 1080 })).toBeCloseTo(1.5, 5);
    expect(computeCloudflareMaximumScale({ width: 3840, height: 2160 })).toBe(3);
    expect(computeCloudflareMaximumScale({ width: 640, height: 480 })).toBe(1);
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
