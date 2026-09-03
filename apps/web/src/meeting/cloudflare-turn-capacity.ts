export const TURN_PROBE_LADDER_BPS = [2_000_000, 4_000_000, 8_000_000, 16_000_000, 32_000_000, 50_000_000] as const;
export const TURN_PROBE_STALE_RETENTION_MS = 60_000;
export const TURN_PROBE_RUNG_CONFIRM_RATIO = 0.85;
export const TURN_PROBE_RUNG_MAX_LOSS_RATIO = 0.02;

export type TurnPathProbeStatus = 'idle' | 'negotiating' | 'probing' | 'ready' | 'stale' | 'unsupported' | 'error';

export interface TurnProbeWindow {
  /** Offered send rate for the window; never derived from media bitrate. */
  offeredBps: number;
  /** Bytes acknowledged as received by the remote probe peer. */
  confirmedBytes: number;
  durationMs: number;
  lossRatio: number;
  roundTripTimeMs?: number;
  sampledAt: number;
  /** Unacked bytes still queued when the window ended; omitted means drained. */
  pendingBytesAtEnd?: number;
  selectedProtocol?: string;
}

export interface TurnPathProbeSnapshot {
  status: TurnPathProbeStatus;
  measuredCapacityBps?: number;
  stableCapacityBps?: number;
  probeTargetBps: number;
  roundTripTimeMs?: number;
  lossRatio?: number;
  selectedProtocol?: string;
  sampledAt?: number;
}

export interface TurnProbeCapacityState {
  snapshot: TurnPathProbeSnapshot;
  recentValidCapacitiesBps: readonly number[];
  staleUntil?: number;
}

export function createTurnProbeCapacityState(): TurnProbeCapacityState {
  return {
    snapshot: {
      status: 'idle',
      probeTargetBps: TURN_PROBE_LADDER_BPS[0]
    },
    recentValidCapacitiesBps: []
  };
}

/** Folds one probe window into capacity state; invalid windows leave the state untouched. */
export function reduceTurnProbeWindow(
  previous: TurnProbeCapacityState,
  window: TurnProbeWindow
): TurnProbeCapacityState {
  if (!isValidWindow(window) || isBackwardSample(previous, window.sampledAt)) return previous;

  const capacityBps = (window.confirmedBytes * 8_000) / window.durationMs;
  const history = useHistoryAfterExpiry(previous, window.sampledAt);
  const recentValidCapacitiesBps = [...history, capacityBps].slice(-3);
  const stableCapacityBps = recentValidCapacitiesBps.length === 3
    ? median(recentValidCapacitiesBps)
    : undefined;

  return {
    snapshot: {
      status: stableCapacityBps === undefined ? 'probing' : 'ready',
      measuredCapacityBps: capacityBps,
      ...(stableCapacityBps === undefined ? {} : { stableCapacityBps }),
      probeTargetBps: nextLadderTarget(previous, window),
      ...(window.roundTripTimeMs === undefined ? {} : { roundTripTimeMs: window.roundTripTimeMs }),
      lossRatio: window.lossRatio,
      ...(window.selectedProtocol === undefined ? {} : { selectedProtocol: window.selectedProtocol }),
      sampledAt: window.sampledAt
    },
    recentValidCapacitiesBps,
    staleUntil: undefined
  };
}

/**
 * Records a probe failure. A capacity measured within the retention window stays
 * published as `stale`; once that window passes, capacity is dropped without
 * ever being replaced by a synthesized zero.
 */
export function markTurnProbeFailure(
  previous: TurnProbeCapacityState,
  now: number
): TurnProbeCapacityState {
  const retained = previous.snapshot.stableCapacityBps !== undefined
    && !isExpired(previous, now);
  const staleUntil = retained && previous.staleUntil !== undefined
    ? previous.staleUntil
    : now + TURN_PROBE_STALE_RETENTION_MS;
  return {
    snapshot: {
      ...previous.snapshot,
      status: retained ? 'stale' : 'error',
      measuredCapacityBps: retained ? previous.snapshot.measuredCapacityBps : undefined,
      stableCapacityBps: retained ? previous.snapshot.stableCapacityBps : undefined
    },
    recentValidCapacitiesBps: retained ? previous.recentValidCapacitiesBps : [],
    staleUntil
  };
}

function isValidWindow(window: TurnProbeWindow): boolean {
  return Number.isFinite(window.durationMs)
    && window.durationMs > 0
    && Number.isFinite(window.confirmedBytes)
    && window.confirmedBytes >= 0
    && Number.isFinite(window.offeredBps)
    && window.offeredBps > 0
    && Number.isFinite(window.lossRatio)
    && window.lossRatio >= 0
    && window.lossRatio <= 1
    && Number.isFinite(window.sampledAt);
}

function isBackwardSample(previous: TurnProbeCapacityState, sampledAt: number): boolean {
  return previous.snapshot.sampledAt !== undefined && sampledAt < previous.snapshot.sampledAt;
}

function isExpired(previous: TurnProbeCapacityState, now: number): boolean {
  return previous.staleUntil !== undefined && now >= previous.staleUntil;
}

/** History measured before a stale period expired no longer represents the path. */
function useHistoryAfterExpiry(previous: TurnProbeCapacityState, sampledAt: number): readonly number[] {
  return isExpired(previous, sampledAt) ? [] : previous.recentValidCapacitiesBps;
}

function nextLadderTarget(previous: TurnProbeCapacityState, window: TurnProbeWindow): number {
  const current = previous.snapshot.probeTargetBps;
  const confirmedBps = (window.confirmedBytes * 8_000) / window.durationMs;
  const confirmedRung = window.lossRatio < TURN_PROBE_RUNG_MAX_LOSS_RATIO
    && confirmedBps >= window.offeredBps * TURN_PROBE_RUNG_CONFIRM_RATIO
    && (window.pendingBytesAtEnd ?? 0) === 0;
  if (!confirmedRung) return current;

  const nextRung = TURN_PROBE_LADDER_BPS.find((rung) => rung > current);
  return nextRung ?? current;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
