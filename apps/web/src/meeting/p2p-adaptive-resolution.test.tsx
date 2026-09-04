import { describe, expect, it } from 'vitest';

import {
  computeP2pMaximumScale,
  createP2pAdaptiveResolutionState,
  updateP2pAdaptiveResolution
} from './p2p-adaptive-resolution.js';

describe('direct and coturn resolution adaptation', () => {
  it('keeps explicit downsampling above a 720p short side', () => {
    expect(computeP2pMaximumScale({ width: 3840, height: 2160 })).toBe(3);
    expect(computeP2pMaximumScale({ width: 1280, height: 720 })).toBe(1);
    expect(computeP2pMaximumScale({})).toBe(1.5);
  });

  it('keeps a static healthy desktop at its profile scale', () => {
    let state = createP2pAdaptiveResolutionState(1);
    for (let sample = 0; sample < 6; sample += 1) {
      state = updateP2pAdaptiveResolution({
        previous: state,
        measurement: {
          actualOutgoingBitrateBps: 400_000,
          qualityLimitationReason: 'none',
          framesPerSecond: 30,
          targetFrameRate: 30
        },
        referenceBitrateBps: 8_000_000,
        minimumScaleResolutionDownBy: 1,
        maximumScaleResolutionDownBy: 1.5
      });
    }

    expect(state.scaleResolutionDownBy).toBe(1);
  });

  it('reduces pixel load only after sustained bandwidth and frame-rate pressure', () => {
    let state = createP2pAdaptiveResolutionState(1);
    const pressure = {
      availableOutgoingBitrateBps: 800_000,
      actualOutgoingBitrateBps: 1_500_000,
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 10,
      targetFrameRate: 60
    };

    state = updateP2pAdaptiveResolution({
      previous: state,
      measurement: pressure,
      referenceBitrateBps: 8_000_000,
      minimumScaleResolutionDownBy: 1,
      maximumScaleResolutionDownBy: 1.5
    });
    state = updateP2pAdaptiveResolution({
      previous: state,
      measurement: pressure,
      referenceBitrateBps: 8_000_000,
      minimumScaleResolutionDownBy: 1,
      maximumScaleResolutionDownBy: 1.5
    });
    expect(state.scaleResolutionDownBy).toBe(1);

    state = updateP2pAdaptiveResolution({
      previous: state,
      measurement: pressure,
      referenceBitrateBps: 8_000_000,
      minimumScaleResolutionDownBy: 1,
      maximumScaleResolutionDownBy: 1.5
    });
    expect(state.scaleResolutionDownBy).toBeCloseTo(1.1, 5);
  });

  it('returns gradually to the profile scale after healthy frame rate recovers', () => {
    let state = {
      ...createP2pAdaptiveResolutionState(1),
      scaleResolutionDownBy: 1.4
    };
    const healthy = {
      actualOutgoingBitrateBps: 2_000_000,
      qualityLimitationReason: 'none',
      framesPerSecond: 60,
      targetFrameRate: 60
    };

    state = updateP2pAdaptiveResolution({
      previous: state,
      measurement: healthy,
      referenceBitrateBps: 8_000_000,
      minimumScaleResolutionDownBy: 1,
      maximumScaleResolutionDownBy: 1.5
    });
    state = updateP2pAdaptiveResolution({
      previous: state,
      measurement: healthy,
      referenceBitrateBps: 8_000_000,
      minimumScaleResolutionDownBy: 1,
      maximumScaleResolutionDownBy: 1.5
    });

    expect(state.scaleResolutionDownBy).toBeCloseTo(1.26, 5);
  });
});
