import { describe, expect, it } from 'vitest';

import {
  CLOUDFLARE_TRANSPORT_MIN_BITRATE_BPS,
  computeCloudflareMaximumScale,
  createCloudflareEncodingState,
  updateCloudflareEncoding,
  type CloudflareEncodingMeasurement,
  type CloudflareEncodingState
} from './cloudflare-adaptive-encoding.js';
import type { TurnPathProbeSnapshot } from './cloudflare-turn-capacity.js';

const PROFILE_TARGET_BPS = 8_000_000;

function probeSnapshot(overrides: Partial<TurnPathProbeSnapshot> = {}): TurnPathProbeSnapshot {
  return { status: 'ready', probeTargetBps: 2_000_000, offeredBps: 8_000_000, ...overrides };
}

function measurement(overrides: Partial<CloudflareEncodingMeasurement> = {}): CloudflareEncodingMeasurement {
  return {
    turnProbe: probeSnapshot(),
    targetFrameRate: 30,
    ...overrides
  };
}

/** A healthy media sample with no limitation and no loss growth. */
function healthyMeasurement(probe: Partial<TurnPathProbeSnapshot> = {}): CloudflareEncodingMeasurement {
  return measurement({
    turnProbe: probeSnapshot({ ...probe }),
    availableOutgoingBitrateBps: 500_000,
    actualOutgoingBitrateBps: 7_000_000,
    qualityLimitationReason: 'none',
    framesPerSecond: 30
  });
}

/** A bandwidth-limited sample with a collapsed frame rate. */
function pressureMeasurement(probe: Partial<TurnPathProbeSnapshot> = {}, sampledAt = 1_000): CloudflareEncodingMeasurement {
  return measurement({
    turnProbe: probeSnapshot({
      measuredCapacityBps: 1_500_000,
      stableCapacityBps: 1_500_000,
      sampledAt,
      ...probe
    }),
    qualityLimitationReason: 'bandwidth',
    framesPerSecond: 10
  });
}

function step(state: CloudflareEncodingMeasurement | CloudflareEncodingState, next: CloudflareEncodingMeasurement, sourceShortSide?: number): CloudflareEncodingState {
  return updateCloudflareEncoding({
    previous: state as CloudflareEncodingState,
    measurement: next,
    ...(sourceShortSide === undefined ? {} : { sourceShortSide })
  });
}

describe('Cloudflare TURN adaptive encoding (fixed target, dynamic cap)', () => {
  it('never mutates the profile target', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    state = step(state, healthyMeasurement({ stableCapacityBps: 40_000_000 }));
    state = step(state, healthyMeasurement({ stableCapacityBps: 40_000_000 }));
    state = step(state, pressureMeasurement({ sampledAt: 1_000 }, 1_000));
    state = step(state, pressureMeasurement({ sampledAt: 2_000 }, 2_000));
    state = step(state, pressureMeasurement({ sampledAt: 3_000 }, 3_000));
    state = step(state, pressureMeasurement({ sampledAt: 4_000 }, 4_000));

    expect(state.profileTargetBitrateBps).toBe(PROFILE_TARGET_BPS);
    expect(state.transportBitrateCapBps).not.toBe(PROFILE_TARGET_BPS);
  });

  it('raises only the transport cap when probe capacity is high', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    state = step(state, healthyMeasurement({ stableCapacityBps: 20_000_000 }));
    state = step(state, healthyMeasurement({ stableCapacityBps: 20_000_000 }));

    expect(state.transportBitrateCapBps).toBe(9_200_000);
    expect(state.profileTargetBitrateBps).toBe(PROFILE_TARGET_BPS);
  });

  it('does not raise from a stale probe capacity', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    const staleProbe = { status: 'stale' as const, stableCapacityBps: 20_000_000, probeTargetBps: 2_000_000 };
    state = step(state, healthyMeasurement(staleProbe));
    state = step(state, healthyMeasurement({ ...staleProbe, sampledAt: 2_000 }));

    expect(state.transportBitrateCapBps).toBe(PROFILE_TARGET_BPS);
  });

  it('treats actual outgoing bitrate as read-only evidence, never as a requested bitrate', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    // High actual bitrate without probe capacity must not raise the cap…
    state = step(state, healthyMeasurement());
    state = step(state, healthyMeasurement());
    expect(state.transportBitrateCapBps).toBe(PROFILE_TARGET_BPS);
    // …and a low actual bitrate must not become the new cap either.
    state = step(state, measurement({
      actualOutgoingBitrateBps: 1_200_000,
      qualityLimitationReason: 'none',
      framesPerSecond: 30,
      turnProbe: probeSnapshot({ measuredCapacityBps: 1_000_000, stableCapacityBps: 1_000_000, sampledAt: 1_000 })
    }));
    expect(state.transportBitrateCapBps).toBe(PROFILE_TARGET_BPS);
  });

  it('ignores low RTC estimate, low actual bitrate, static fps, and one low probe', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    state = step(state, measurement({
      availableOutgoingBitrateBps: 500_000,
      actualOutgoingBitrateBps: 200_000,
      qualityLimitationReason: 'none',
      framesPerSecond: 5,
      turnProbe: probeSnapshot({ measuredCapacityBps: 1_000_000, sampledAt: 1_000 })
    }));

    expect(state.transportBitrateCapBps).toBe(PROFILE_TARGET_BPS);
    expect(state.scaleResolutionDownBy).toBe(1);
    expect(state.bandwidthPressureSamples).toBe(0);
    expect(state.lowProbeSamples).toBe(1);
  });

  it('uses RTT growth only when the affected output also loses frame rate', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    state = step(state, measurement({
      qualityLimitationReason: 'none', framesPerSecond: 30, roundTripTimeMs: 100,
      turnProbe: probeSnapshot({ measuredCapacityBps: 1_500_000, stableCapacityBps: 1_500_000, sampledAt: 1_000 })
    }));
    state = step(state, measurement({
      qualityLimitationReason: 'none', framesPerSecond: 10, roundTripTimeMs: 220,
      turnProbe: probeSnapshot({ measuredCapacityBps: 1_500_000, stableCapacityBps: 1_500_000, sampledAt: 2_000 })
    }));
    state = step(state, measurement({
      qualityLimitationReason: 'none', framesPerSecond: 10, roundTripTimeMs: 340,
      turnProbe: probeSnapshot({ measuredCapacityBps: 1_500_000, stableCapacityBps: 1_500_000, sampledAt: 3_000 })
    }));

    expect(state.bandwidthPressureSamples).toBe(2);
    expect(state.transportBitrateCapBps).toBe(PROFILE_TARGET_BPS);
  });

  it('does not count a bandwidth label as pressure while output remains healthy', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    state = step(state, measurement({
      qualityLimitationReason: 'bandwidth', framesPerSecond: 30,
      turnProbe: probeSnapshot({ stableCapacityBps: 20_000_000, sampledAt: 1_000 })
    }));
    state = step(state, measurement({
      qualityLimitationReason: 'bandwidth', framesPerSecond: 30,
      turnProbe: probeSnapshot({ stableCapacityBps: 20_000_000, sampledAt: 2_000 })
    }));
    state = step(state, measurement({
      qualityLimitationReason: 'bandwidth', framesPerSecond: 30,
      turnProbe: probeSnapshot({ stableCapacityBps: 20_000_000, sampledAt: 3_000 })
    }));

    expect(state.bandwidthPressureSamples).toBe(0);
    expect(state.transportBitrateCapBps).toBe(PROFILE_TARGET_BPS);
  });

  it('does not raise the cap while RTT has materially increased', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    state = step(state, measurement({
      qualityLimitationReason: 'none', framesPerSecond: 30, roundTripTimeMs: 100,
      turnProbe: probeSnapshot({ stableCapacityBps: 20_000_000, sampledAt: 1_000 })
    }));
    state = step(state, measurement({
      qualityLimitationReason: 'none', framesPerSecond: 30, roundTripTimeMs: 220,
      turnProbe: probeSnapshot({ stableCapacityBps: 20_000_000, sampledAt: 2_000 })
    }));

    expect(state.transportBitrateCapBps).toBe(PROFILE_TARGET_BPS);
  });

  it('requires two low probe windows plus three pressure samples to back off', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    state = step(state, pressureMeasurement({}, 1_000));
    state = step(state, pressureMeasurement({}, 2_000));
    // Two corroborating signals but only two pressure samples: no backoff yet.
    expect(state.transportBitrateCapBps).toBe(PROFILE_TARGET_BPS);

    state = step(state, pressureMeasurement({}, 3_000));
    expect(state.transportBitrateCapBps).toBe(6_400_000);
  });

  it('counts a low probe only when that window offered enough rate to test the current cap', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    for (const [sampledAt, offeredBps] of [[1_000, 2_000_000], [2_000, 4_000_000], [3_000, 8_000_000]] as const) {
      state = step(state, pressureMeasurement({ offeredBps } as unknown as Partial<TurnPathProbeSnapshot>, sampledAt));
    }

    expect(state.lowProbeSamples).toBe(1);
    expect(state.transportBitrateCapBps).toBe(PROFILE_TARGET_BPS);
  });

  it('does not let one severe sample bypass three sustained media-pressure samples', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    const severe = measurement({
      turnProbe: probeSnapshot({ offeredBps: 8_000_000, measuredCapacityBps: 1_500_000, sampledAt: 1_000 } as unknown as Partial<TurnPathProbeSnapshot>),
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 5,
      packetLossRatio: 0.08,
      targetFrameRate: 30
    });
    const low = pressureMeasurement({ offeredBps: 8_000_000 } as unknown as Partial<TurnPathProbeSnapshot>, 2_000);
    state = step(state, low);
    state = step(state, severe);

    expect(state.bandwidthPressureSamples).toBe(2);
    expect(state.lowProbeSamples).toBe(2);
    expect(state.transportBitrateCapBps).toBe(PROFILE_TARGET_BPS);

    state = step(state, pressureMeasurement({ offeredBps: 8_000_000 } as unknown as Partial<TurnPathProbeSnapshot>, 3_000));
    expect(state.transportBitrateCapBps).toBeLessThan(PROFILE_TARGET_BPS);
  });

  it('backs off between 5 and 20 percent and never increases in the down branch', () => {
    let state: CloudflareEncodingState = {
      ...createCloudflareEncodingState(PROFILE_TARGET_BPS),
      lastStableBitrateBps: 7_800_000
    };
    state = step(state, pressureMeasurement({}, 1_000));
    state = step(state, pressureMeasurement({}, 2_000));
    state = step(state, pressureMeasurement({}, 3_000));

    const firstDrop = state.transportBitrateCapBps;
    expect(firstDrop).toBeGreaterThan(PROFILE_TARGET_BPS * 0.80);
    expect(firstDrop).toBeLessThan(PROFILE_TARGET_BPS * 0.95);

    for (let round = 0; round < 6; round += 1) {
      const previous = state.transportBitrateCapBps;
      state = step(state, pressureMeasurement({ sampledAt: 4_000 + round * 1_000 }, 4_000 + round * 1_000));
      state = step(state, pressureMeasurement({ sampledAt: 5_000 + round * 1_000 }, 5_000 + round * 1_000));
      state = step(state, pressureMeasurement({ sampledAt: 6_000 + round * 1_000 }, 6_000 + round * 1_000));
      expect(state.transportBitrateCapBps).toBeLessThanOrEqual(previous);
    }
    expect(state.transportBitrateCapBps).toBeGreaterThanOrEqual(CLOUDFLARE_TRANSPORT_MIN_BITRATE_BPS);
  });

  it('keeps probe recovery independent from the transport cap', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    for (let index = 0; index < 3; index += 1) {
      state = step(state, pressureMeasurement({}, 1_000 + index * 1_000));
    }
    expect(state.transportBitrateCapBps).toBeLessThan(PROFILE_TARGET_BPS);

    // The same probe later reports a much higher stable capacity with healthy media.
    state = step(state, healthyMeasurement({ stableCapacityBps: 20_000_000 }));
    state = step(state, healthyMeasurement({ stableCapacityBps: 20_000_000 }));

    expect(state.transportBitrateCapBps).toBeGreaterThan(6_400_000);
    expect(state.profileTargetBitrateBps).toBe(PROFILE_TARGET_BPS);
  });

  it('changes scale by at most 10 percent down and 5 percent up', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    for (let index = 0; index < 3; index += 1) {
      state = step(state, pressureMeasurement({}, 1_000 + index * 1_000), 1080);
    }
    const scaledUp = state.scaleResolutionDownBy;
    expect(scaledUp).toBeCloseTo(1.1, 5);

    // Recovery: five healthy samples gate, then at most 5% scale reduction per update.
    for (let index = 0; index < 5; index += 1) {
      state = step(state, healthyMeasurement({ stableCapacityBps: 20_000_000 }), 1080);
    }
    const beforeRecovery = state.scaleResolutionDownBy;
    state = step(state, healthyMeasurement({ stableCapacityBps: 20_000_000 }), 1080);
    expect(state.scaleResolutionDownBy).toBeLessThan(beforeRecovery);
    expect(beforeRecovery - state.scaleResolutionDownBy).toBeLessThanOrEqual(beforeRecovery * 0.05 + 1e-9);
  });

  it('uses 720p normal and 540p emergency short-side floors', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    // Drive the cap to the floor with sustained corroborated pressure.
    for (let round = 0; round < 12; round += 1) {
      const base = 1_000 + round * 3_000;
      state = step(state, pressureMeasurement({ sampledAt: base }, base), 1080);
      state = step(state, pressureMeasurement({ sampledAt: base + 1_000 }, base + 1_000), 1080);
      state = step(state, pressureMeasurement({ sampledAt: base + 2_000 }, base + 2_000), 1080);
    }
    expect(state.scaleResolutionDownBy).toBeCloseTo(1.5, 2);

    // Severe pressure (collapsed fps plus heavy loss) unlocks the 540p layer.
    for (let index = 0; index < 2; index += 1) {
      state = step(state, measurement({
        turnProbe: probeSnapshot({
          measuredCapacityBps: 900_000,
          stableCapacityBps: 900_000,
          sampledAt: 50_000 + index * 1_000
        }),
        qualityLimitationReason: 'bandwidth',
        framesPerSecond: 5,
        packetLossRatio: 0.08
      }), 1080);
    }
    state = step(state, measurement({
      turnProbe: probeSnapshot({ measuredCapacityBps: 900_000, sampledAt: 52_000 }),
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 5,
      packetLossRatio: 0.08
    }), 1080);

    expect(state.emergencyResolution).toBe(true);
    expect(state.scaleResolutionDownBy).toBeLessThanOrEqual(2);
  });

  it('recovers from the emergency scale within the five-percent slew limit', () => {
    const previous: CloudflareEncodingState = {
      ...createCloudflareEncodingState(PROFILE_TARGET_BPS),
      emergencyResolution: true,
      scaleResolutionDownBy: 2,
      healthyRecoverySamples: 4
    };
    const next = step(previous, healthyMeasurement({ stableCapacityBps: 20_000_000 }), 1080);

    expect(next.emergencyResolution).toBe(false);
    expect(next.scaleResolutionDownBy).toBeCloseTo(1.9, 5);
  });

  it('activates hard resolution protection below 540p', () => {
    let state = createCloudflareEncodingState(PROFILE_TARGET_BPS);
    state = step(state, measurement({
      qualityLimitationReason: 'none',
      framesPerSecond: 30,
      frameWidth: 854,
      frameHeight: 480
    }));
    expect(state.hardResolutionProtection).toBe(true);

    state = step(state, measurement({
      qualityLimitationReason: 'none',
      framesPerSecond: 30,
      frameWidth: 960,
      frameHeight: 540
    }));
    expect(state.hardResolutionProtection).toBe(false);
  });

  it('falls back to the absolute scale bound without a known source size', () => {
    expect(computeCloudflareMaximumScale({ width: 1728, height: 1080 }, false)).toBeCloseTo(1.5, 5);
    expect(computeCloudflareMaximumScale({ width: 1728, height: 1080 }, true)).toBeCloseTo(2, 5);
    expect(computeCloudflareMaximumScale({}, false)).toBe(2);
  });
});
