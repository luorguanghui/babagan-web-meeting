import { describe, expect, it } from 'vitest';

import {
  CLOUDFLARE_PROBE_INITIAL_BITRATE_BPS,
  computeCloudflareMaximumScale,
  updateCloudflareEncoding,
  type CloudflareEncodingState
} from './cloudflare-adaptive-encoding.js';

const initialState: CloudflareEncodingState = {
  targetBitrateBps: 8_000_000,
  scaleResolutionDownBy: 1
};

describe('Cloudflare TURN adaptive encoding', () => {
  it('ignores a low RTC estimate and probes upward after two healthy sender samples', () => {
    const measurement = {
      availableOutgoingBitrateBps: 700_000,
      actualOutgoingBitrateBps: 10_400_000,
      qualityLimitationReason: 'none',
      framesPerSecond: 60,
      targetFrameRate: 60
    };
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

    expect(first.targetBitrateBps).toBe(CLOUDFLARE_PROBE_INITIAL_BITRATE_BPS);
    expect(first.scaleResolutionDownBy).toBe(1);
    expect(second.targetBitrateBps).toBe(11_500_000);
    expect(second.trustedAvailableOutgoingBitrateBps).toBe(10_400_000);
    expect(second.probeStatus).toBe('stable');
  });

  it('uses the independent Cloudflare upload test as the initial probe target', () => {
    const next = updateCloudflareEncoding({
      previous: initialState,
      measurement: { testedCloudflareUplinkBitrateBps: 18_000_000 },
      minimumScaleResolutionDownBy: 1
    });

    expect(next.targetBitrateBps).toBe(15_300_000);
    expect(next.testedCloudflareUplinkBitrateBps).toBe(18_000_000);
    expect(next.probeStatus).toBe('probing');
  });

  it('smoothly lowers bitrate and sampling scale when a later upload test is slow', () => {
    const previous: CloudflareEncodingState = {
      targetBitrateBps: 15_300_000,
      scaleResolutionDownBy: 1,
      testedCloudflareUplinkBitrateBps: 18_000_000,
      probeStatus: 'stable'
    };
    const first = updateCloudflareEncoding({
      previous,
      measurement: { testedCloudflareUplinkBitrateBps: 4_000_000 },
      minimumScaleResolutionDownBy: 1,
      referenceBitrateBps: 15_000_000
    });
    const second = updateCloudflareEncoding({
      previous: first,
      measurement: { testedCloudflareUplinkBitrateBps: 4_000_000 },
      minimumScaleResolutionDownBy: 1,
      referenceBitrateBps: 15_000_000
    });

    expect(first.targetBitrateBps).toBeLessThan(previous.targetBitrateBps);
    expect(first.targetBitrateBps).toBeGreaterThan(3_400_000);
    expect(first.scaleResolutionDownBy).toBeCloseTo(1.1, 5);
    expect(second.targetBitrateBps).toBeLessThan(first.targetBitrateBps);
    expect(second.scaleResolutionDownBy).toBeCloseTo(1.21, 5);
  });

  it('does not back off from a low RTC estimate by itself', () => {
    let state: CloudflareEncodingState = {
      targetBitrateBps: 15_000_000,
      scaleResolutionDownBy: 1,
      probeStatus: 'stable'
    };
    for (let sample = 0; sample < 10; sample += 1) {
      state = updateCloudflareEncoding({
        previous: state,
        measurement: { availableOutgoingBitrateBps: 500_000 },
        minimumScaleResolutionDownBy: 1
      });
    }

    expect(state.targetBitrateBps).toBe(15_000_000);
    expect(state.scaleResolutionDownBy).toBe(1);
  });

  it('backs off smoothly only after three sustained sender-congestion samples', () => {
    const measurement = {
      availableOutgoingBitrateBps: 700_000,
      actualOutgoingBitrateBps: 4_000_000,
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 12,
      targetFrameRate: 60
    };
    let state: CloudflareEncodingState = {
      targetBitrateBps: 15_000_000,
      scaleResolutionDownBy: 1,
      probeStatus: 'stable'
    };
    state = updateCloudflareEncoding({ previous: state, measurement, minimumScaleResolutionDownBy: 1 });
    state = updateCloudflareEncoding({ previous: state, measurement, minimumScaleResolutionDownBy: 1 });
    expect(state.targetBitrateBps).toBe(15_000_000);
    expect(state.scaleResolutionDownBy).toBe(1);

    state = updateCloudflareEncoding({
      previous: state,
      measurement,
      minimumScaleResolutionDownBy: 1,
      referenceBitrateBps: 15_000_000
    });

    expect(state.targetBitrateBps).toBeLessThan(15_000_000);
    expect(state.targetBitrateBps).toBeGreaterThan(4_000_000);
    expect(state.scaleResolutionDownBy).toBeCloseTo(1.1, 5);
    expect(state.probeStatus).toBe('constrained');
  });

  it('does not let a previously applied upload result undo congestion backoff', () => {
    const measurement = {
      testedCloudflareUplinkBitrateBps: 18_000_000,
      actualOutgoingBitrateBps: 4_000_000,
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 12,
      targetFrameRate: 60
    };
    let state = updateCloudflareEncoding({
      previous: initialState,
      measurement: { testedCloudflareUplinkBitrateBps: 18_000_000 },
      minimumScaleResolutionDownBy: 1
    });
    for (let sample = 0; sample < 3; sample += 1) {
      state = updateCloudflareEncoding({ previous: state, measurement, minimumScaleResolutionDownBy: 1 });
    }
    const backedOffTarget = state.targetBitrateBps;

    state = updateCloudflareEncoding({ previous: state, measurement, minimumScaleResolutionDownBy: 1 });

    expect(backedOffTarget).toBeLessThan(15_300_000);
    expect(state.targetBitrateBps).toBe(backedOffTarget);
  });

  it('keeps a 1728x1080 source from falling below a 720p short side', () => {
    let state: CloudflareEncodingState = {
      targetBitrateBps: 10_000_000,
      scaleResolutionDownBy: 1,
      probeStatus: 'stable'
    };
    for (let sample = 0; sample < 40; sample += 1) {
      state = updateCloudflareEncoding({
        previous: state,
        measurement: {
          availableOutgoingBitrateBps: 500_000,
          actualOutgoingBitrateBps: 500_000,
          qualityLimitationReason: 'bandwidth',
          framesPerSecond: 10,
          targetFrameRate: 60
        },
        minimumScaleResolutionDownBy: 1,
        maximumScaleResolutionDownBy: 1.5,
        referenceBitrateBps: 10_000_000
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

  it('can exceed the old 40 Mbps aggregate budget through healthy probing', () => {
    const measurement = {
      actualOutgoingBitrateBps: 42_000_000,
      qualityLimitationReason: 'none',
      framesPerSecond: 60,
      targetFrameRate: 60
    };
    const first = updateCloudflareEncoding({
      previous: { targetBitrateBps: 40_000_000, scaleResolutionDownBy: 1 },
      measurement,
      minimumScaleResolutionDownBy: 1
    });
    const second = updateCloudflareEncoding({ previous: first, measurement, minimumScaleResolutionDownBy: 1 });

    expect(second.targetBitrateBps).toBeGreaterThan(40_000_000);
  });

  it('holds the previous state when the connection exposes no usable evidence', () => {
    const state: CloudflareEncodingState = {
      targetBitrateBps: 15_000_000,
      scaleResolutionDownBy: 1,
      probeStatus: 'stable'
    };
    expect(updateCloudflareEncoding({
      previous: state,
      measurement: {},
      minimumScaleResolutionDownBy: 1
    })).toEqual(state);
  });

  it('does not choke bitrate or scale down when HTTP upload probe is 0.3 Mbps but RTC estimate is 9 Mbps', () => {
    const previous: CloudflareEncodingState = {
      targetBitrateBps: 10_000_000,
      scaleResolutionDownBy: 1,
      probeStatus: 'stable'
    };
    const measurement = {
      testedCloudflareUplinkBitrateBps: 300_000, // low HTTP upload test (0.3 Mbps)
      availableOutgoingBitrateBps: 9_000_000,   // real RTC candidate-pair estimate (9 Mbps)
      actualOutgoingBitrateBps: 8_500_000,
      qualityLimitationReason: 'none',
      framesPerSecond: 30,
      targetFrameRate: 30
    };

    const first = updateCloudflareEncoding({
      previous,
      measurement,
      minimumScaleResolutionDownBy: 1,
      referenceBitrateBps: 10_000_000
    });
    const second = updateCloudflareEncoding({
      previous: first,
      measurement,
      minimumScaleResolutionDownBy: 1,
      referenceBitrateBps: 10_000_000
    });

    // Must NOT be throttled down towards 1 Mbps
    expect(first.targetBitrateBps).toBeGreaterThanOrEqual(10_000_000);
    expect(first.scaleResolutionDownBy).toBe(1);
    expect(second.targetBitrateBps).toBeGreaterThanOrEqual(10_000_000);
    expect(second.scaleResolutionDownBy).toBe(1);
  });

  it('does not lower sampling rate on static content when bitrate is low but limitation is none', () => {
    const previous: CloudflareEncodingState = {
      targetBitrateBps: 8_000_000,
      scaleResolutionDownBy: 1,
      probeStatus: 'stable'
    };
    // Static desktop: encoder emits only 400 kbps, but framerate is steady 30fps and limitation is none
    const measurement = {
      actualOutgoingBitrateBps: 400_000,
      qualityLimitationReason: 'none',
      framesPerSecond: 30,
      targetFrameRate: 30
    };

    let state = previous;
    for (let i = 0; i < 5; i++) {
      state = updateCloudflareEncoding({
        previous: state,
        measurement,
        minimumScaleResolutionDownBy: 1,
        referenceBitrateBps: 8_000_000
      });
    }

    expect(state.scaleResolutionDownBy).toBe(1);
    expect(state.targetBitrateBps).toBeGreaterThanOrEqual(8_000_000);
  });

  it('reduces sampling rate to recover collapsed framerate under congestion, then restores scale without vicious cycle', () => {
    const previous: CloudflareEncodingState = {
      targetBitrateBps: 8_000_000,
      scaleResolutionDownBy: 1,
      probeStatus: 'stable'
    };

    // 1. Congestion: actual bitrate is low and framerate collapsed
    const congestedMeasurement = {
      actualOutgoingBitrateBps: 1_500_000,
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 10,
      targetFrameRate: 60
    };

    let state = previous;
    for (let i = 0; i < 3; i++) {
      state = updateCloudflareEncoding({
        previous: state,
        measurement: congestedMeasurement,
        minimumScaleResolutionDownBy: 1,
        referenceBitrateBps: 8_000_000
      });
    }

    // Scale must step up to reduce pixel load and relieve the framerate
    expect(state.scaleResolutionDownBy).toBeGreaterThan(1);
    const congestedScale = state.scaleResolutionDownBy;

    // 2. Framerate recovers thanks to downsampling, stream becomes healthy
    const recoveredMeasurement = {
      actualOutgoingBitrateBps: 1_800_000,
      qualityLimitationReason: 'none',
      framesPerSecond: 60,
      targetFrameRate: 60
    };

    for (let i = 0; i < 6; i++) {
      state = updateCloudflareEncoding({
        previous: state,
        measurement: recoveredMeasurement,
        minimumScaleResolutionDownBy: 1,
        referenceBitrateBps: 8_000_000
      });
    }

    // Scale must steadily recover back towards 1 without getting trapped in low bitrate
    expect(state.scaleResolutionDownBy).toBeLessThan(congestedScale);
    expect(state.scaleResolutionDownBy).toBeCloseTo(1, 1);
  });
});
