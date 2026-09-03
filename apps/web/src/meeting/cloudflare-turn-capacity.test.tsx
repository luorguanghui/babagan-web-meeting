import { describe, expect, it } from 'vitest';

import {
  TURN_PROBE_LADDER_BPS,
  TURN_PROBE_STALE_RETENTION_MS,
  createTurnProbeCapacityState,
  markTurnProbeFailure,
  reduceTurnProbeWindow,
  type TurnProbeCapacityState,
  type TurnProbeWindow
} from './cloudflare-turn-capacity.js';

function window(overrides: Partial<TurnProbeWindow> = {}): TurnProbeWindow {
  return {
    offeredBps: 2_000_000,
    confirmedBytes: 250_000,
    durationMs: 1_000,
    lossRatio: 0,
    sampledAt: 1_000,
    ...overrides
  };
}

/** Confirms the full ladder so a test can reach a stable, fully-rung state quickly. */
function probingState(capacitiesBps: number[], startAt = 1_000): TurnProbeCapacityState {
  let state = createTurnProbeCapacityState();
  capacitiesBps.forEach((capacityBps, index) => {
    const offeredBps = TURN_PROBE_LADDER_BPS[Math.min(index, TURN_PROBE_LADDER_BPS.length - 1)];
    state = reduceTurnProbeWindow(
      state,
      window({
        offeredBps,
        confirmedBytes: (capacityBps * 1_000) / 8_000,
        sampledAt: startAt + (index + 1) * 1_000
      })
    );
  });
  return state;
}

describe('TURN probe capacity reducer', () => {
  it('uses confirmed bytes instead of offered bytes', () => {
    const state = reduceTurnProbeWindow(
      createTurnProbeCapacityState(),
      window({ offeredBps: 8_000_000, confirmedBytes: 250_000, durationMs: 1_000 })
    );

    expect(state.snapshot.measuredCapacityBps).toBe(2_000_000);
  });

  it('requires three valid windows before publishing stable capacity', () => {
    let state = createTurnProbeCapacityState();
    state = reduceTurnProbeWindow(state, window({ sampledAt: 1_000 }));
    expect(state.snapshot.status).toBe('probing');
    expect(state.snapshot.stableCapacityBps).toBeUndefined();

    state = reduceTurnProbeWindow(state, window({ sampledAt: 2_000 }));
    expect(state.snapshot.stableCapacityBps).toBeUndefined();

    state = reduceTurnProbeWindow(state, window({ sampledAt: 3_000 }));
    expect(state.snapshot.status).toBe('ready');
    expect(state.snapshot.stableCapacityBps).toBe(2_000_000);
  });

  it('uses the median of the latest three valid capacities', () => {
    const state = probingState([4_000_000, 6_000_000, 8_000_000, 20_000_000]);

    expect(state.recentValidCapacitiesBps).toEqual([6_000_000, 8_000_000, 20_000_000]);
    expect(state.snapshot.stableCapacityBps).toBe(8_000_000);
  });

  it('does not replace stable capacity with one low window', () => {
    let state = probingState([4_000_000, 6_000_000, 8_000_000]);
    expect(state.snapshot.stableCapacityBps).toBe(6_000_000);

    state = reduceTurnProbeWindow(
      state,
      window({
        offeredBps: 16_000_000,
        confirmedBytes: (500_000 * 1_000) / 8_000,
        sampledAt: 4_000
      })
    );

    expect(state.snapshot.stableCapacityBps).toBe(6_000_000);
    expect(state.snapshot.measuredCapacityBps).toBe(500_000);
  });

  it('marks a recent result stale for 60 seconds after failure', () => {
    const ready = probingState([4_000_000, 6_000_000, 8_000_000]);
    const failed = markTurnProbeFailure(ready, 5_000);

    expect(failed.snapshot.status).toBe('stale');
    expect(failed.snapshot.stableCapacityBps).toBe(6_000_000);
    expect(failed.staleUntil).toBe(5_000 + TURN_PROBE_STALE_RETENTION_MS);
  });

  it('drops expired stable capacity without reporting zero', () => {
    const ready = probingState([4_000_000, 6_000_000, 8_000_000]);
    const stale = markTurnProbeFailure(ready, 5_000);
    const expired = markTurnProbeFailure(stale, 5_000 + TURN_PROBE_STALE_RETENTION_MS + 1);

    expect(expired.snapshot.status).toBe('error');
    expect(expired.snapshot.stableCapacityBps).toBeUndefined();
    expect(expired.snapshot.measuredCapacityBps).toBeUndefined();
    expect(expired.recentValidCapacitiesBps).toEqual([]);
  });

  it('advances the independent probe ladder even when media is capped low', () => {
    // The reducer never sees media state: probe rungs advance purely from probe windows,
    // so a media maxBitrate capped at 1 Mbps cannot hold the ladder down.
    let state = createTurnProbeCapacityState();
    expect(state.snapshot.probeTargetBps).toBe(TURN_PROBE_LADDER_BPS[0]);

    state = reduceTurnProbeWindow(
      state,
      window({ offeredBps: 2_000_000, confirmedBytes: 425_000, durationMs: 500, sampledAt: 1_000 })
    );
    expect(state.snapshot.probeTargetBps).toBe(4_000_000);

    state = reduceTurnProbeWindow(
      state,
      window({ offeredBps: 4_000_000, confirmedBytes: 500_000, durationMs: 500, sampledAt: 2_000 })
    );
    expect(state.snapshot.probeTargetBps).toBe(8_000_000);
  });

  it('holds the ladder when throughput, loss, or the send queue misses the rung', () => {
    const base = { offeredBps: 2_000_000, durationMs: 1_000, sampledAt: 1_000 };

    const slow = reduceTurnProbeWindow(
      createTurnProbeCapacityState(),
      window({ ...base, confirmedBytes: 200_000 })
    );
    expect(slow.snapshot.probeTargetBps).toBe(2_000_000);

    const lossy = reduceTurnProbeWindow(
      createTurnProbeCapacityState(),
      window({ ...base, confirmedBytes: 250_000, lossRatio: 0.05 })
    );
    expect(lossy.snapshot.probeTargetBps).toBe(2_000_000);

    const queued = reduceTurnProbeWindow(
      createTurnProbeCapacityState(),
      window({ ...base, confirmedBytes: 250_000, pendingBytesAtEnd: 65_536 })
    );
    expect(queued.snapshot.probeTargetBps).toBe(2_000_000);
  });

  it('stops the ladder at the 50 Mbps rung', () => {
    let state = createTurnProbeCapacityState();
    TURN_PROBE_LADDER_BPS.forEach((rungBps, index) => {
      state = reduceTurnProbeWindow(
        state,
        window({
          offeredBps: rungBps,
          confirmedBytes: (rungBps * 1_000) / 8_000,
          durationMs: 1_000,
          sampledAt: 1_000 + index * 1_000
        })
      );
    });
    expect(state.snapshot.probeTargetBps).toBe(50_000_000);

    state = reduceTurnProbeWindow(
      state,
      window({ offeredBps: 50_000_000, confirmedBytes: 6_250_000, durationMs: 1_000, sampledAt: 8_000 })
    );
    expect(state.snapshot.probeTargetBps).toBe(50_000_000);
  });

  it('rejects invalid windows without changing state', () => {
    const ready = probingState([4_000_000, 6_000_000, 8_000_000]);

    expect(reduceTurnProbeWindow(ready, window({ durationMs: 0, sampledAt: 4_000 }))).toBe(ready);
    expect(reduceTurnProbeWindow(ready, window({ durationMs: Number.NaN, sampledAt: 4_000 }))).toBe(ready);
    expect(reduceTurnProbeWindow(ready, window({ lossRatio: 1.5, sampledAt: 4_000 }))).toBe(ready);
    expect(reduceTurnProbeWindow(ready, window({ sampledAt: 500 }))).toBe(ready);
  });

  it('restarts sampling from one window after capacity expires', () => {
    const ready = probingState([4_000_000, 6_000_000, 8_000_000]);
    const stale = markTurnProbeFailure(ready, 5_000);
    const recovered = reduceTurnProbeWindow(
      stale,
      window({ offeredBps: 2_000_000, confirmedBytes: 250_000, durationMs: 1_000, sampledAt: 5_000 + TURN_PROBE_STALE_RETENTION_MS + 1 })
    );

    expect(recovered.snapshot.status).toBe('probing');
    expect(recovered.snapshot.stableCapacityBps).toBeUndefined();
    expect(recovered.recentValidCapacitiesBps).toEqual([2_000_000]);
    expect(recovered.staleUntil).toBeUndefined();
  });
});
