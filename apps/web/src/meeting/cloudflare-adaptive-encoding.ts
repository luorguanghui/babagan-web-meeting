import type { TurnPathProbeSnapshot } from './cloudflare-turn-capacity.js';

export const CLOUDFLARE_TRANSPORT_MIN_BITRATE_BPS = 1_000_000;
export const CLOUDFLARE_TRANSPORT_MAX_BITRATE_BPS = 50_000_000;
export const CLOUDFLARE_TRANSPORT_RAISE_RATIO = 1.15;
export const CLOUDFLARE_TRANSPORT_RAISE_CAPACITY_RATIO = 1.15;
export const CLOUDFLARE_TRANSPORT_RAISE_CAPACITY_HEADROOM = 0.90;
export const CLOUDFLARE_TRANSPORT_DROP_FLOOR_RATIO = 0.80;
export const CLOUDFLARE_TRANSPORT_DROP_CEILING_RATIO = 0.95;
export const CLOUDFLARE_TRANSPORT_DROP_LAST_STABLE_RATIO = 0.90;
export const CLOUDFLARE_HEALTHY_RAISE_SAMPLES = 2;
export const CLOUDFLARE_RECOVERY_HEALTHY_SAMPLES = 5;
export const CLOUDFLARE_PRESSURE_SAMPLE_LIMIT = 3;
export const CLOUDFLARE_LOW_PROBE_SAMPLE_LIMIT = 2;
export const CLOUDFLARE_HEALTHY_FPS_RATIO = 0.85;
export const CLOUDFLARE_SEVERE_FPS_RATIO = 0.5;
export const CLOUDFLARE_PRESSURE_LOSS_RATIO = 0.02;
export const CLOUDFLARE_SEVERE_LOSS_RATIO = 0.05;
export const CLOUDFLARE_RTT_PRESSURE_GROWTH_MS = 50;
export const CLOUDFLARE_RTT_PRESSURE_GROWTH_RATIO = 1.5;
export const CLOUDFLARE_ENCODER_PRESSURE_RATIO = 0.75;
export const CLOUDFLARE_MAX_SCALE_INCREASE_STEP = 0.10;
export const CLOUDFLARE_MAX_SCALE_RECOVERY_STEP = 0.05;
export const CLOUDFLARE_NORMAL_SHORT_SIDE_PX = 720;
export const CLOUDFLARE_EMERGENCY_SHORT_SIDE_PX = 540;
export const CLOUDFLARE_MAX_SCALE_RESOLUTION_DOWN_BY = 4;
export const CLOUDFLARE_UNKNOWN_SOURCE_MAX_SCALE = 2;

/**
 * Per-viewer encoding control state. `profileTargetBitrateBps` is the user's
 * quality tier and never changes for the lifetime of a share; every dynamic
 * decision writes `transportBitrateCapBps` only.
 */
export interface CloudflareEncodingState {
  profileTargetBitrateBps: number;
  transportBitrateCapBps: number;
  scaleResolutionDownBy: number;
  emergencyResolution: boolean;
  hardResolutionProtection: boolean;
  bandwidthPressureSamples: number;
  healthySamples: number;
  healthyRecoverySamples: number;
  lowProbeSamples: number;
  lastProbeSampledAt?: number;
  lastStableBitrateBps?: number;
  lastRoundTripTimeMs?: number;
}

export interface CloudflareEncodingMeasurement {
  /** Latest independent TURN path probe snapshot; the only raising signal. */
  turnProbe: TurnPathProbeSnapshot;
  /** Encoder-reported instantaneous target; read-only evidence. */
  encoderTargetBitrateBps?: number;
  /** Actual outbound rate from RTP byte deltas; read-only evidence. */
  actualOutgoingBitrateBps?: number;
  /** Browser congestion estimate; diagnostics only, never a control input. */
  availableOutgoingBitrateBps?: number;
  qualityLimitationReason?: string;
  framesPerSecond?: number;
  targetFrameRate: number;
  packetLossRatio?: number;
  roundTripTimeMs?: number;
  packetsDiscardedOnSendDelta?: number;
  frameWidth?: number;
  frameHeight?: number;
}

export interface CloudflareEncodingUpdate {
  previous: CloudflareEncodingState;
  measurement: CloudflareEncodingMeasurement;
  /** Shorter side of the capture source; bounds sampling via the resolution floors. */
  sourceShortSide?: number;
}

export function createCloudflareEncodingState(profileTargetBitrateBps: number): CloudflareEncodingState {
  return {
    profileTargetBitrateBps: profileTargetBitrateBps,
    transportBitrateCapBps: profileTargetBitrateBps,
    scaleResolutionDownBy: 1,
    emergencyResolution: false,
    hardResolutionProtection: false,
    bandwidthPressureSamples: 0,
    healthySamples: 0,
    healthyRecoverySamples: 0,
    lowProbeSamples: 0
  };
}

/**
 * Adjusts the transport cap and sampling scale for one viewer.
 *
 * Raising requires a high stable probe capacity plus healthy media samples.
 * Lowering requires two independent low probe windows AND sustained real media
 * pressure, and can never run away: one step is 5–20% and the floor is 1 Mbps.
 * A low RTC estimate, a low actual bitrate, static content, missing stats, or
 * a single low probe window never lowers anything on its own.
 */
export function updateCloudflareEncoding(input: CloudflareEncodingUpdate): CloudflareEncodingState {
  const { previous, measurement } = input;
  const currentCap = previous.transportBitrateCapBps;

  const probeWindow = readNewProbeWindow(previous, measurement.turnProbe);
  let lowProbeSamples = probeWindow === undefined
    ? previous.lowProbeSamples
    : probeWindow.measuredBps < currentCap && probeWindow.offeredBps >= currentCap
      ? previous.lowProbeSamples + 1
      : 0;

  const fps = positive(measurement.framesPerSecond);
  const targetFps = positive(measurement.targetFrameRate);
  const bandwidthLimited = measurement.qualityLimitationReason === 'bandwidth';
  const cpuLimited = measurement.qualityLimitationReason === 'cpu';
  const fpsCollapsed = fps !== undefined && targetFps !== undefined
    && fps < targetFps * CLOUDFLARE_SEVERE_FPS_RATIO;
  const lossRatio = finite(measurement.packetLossRatio);
  const lossBad = lossRatio !== undefined && lossRatio >= CLOUDFLARE_PRESSURE_LOSS_RATIO;
  const discardsBad = (measurement.packetsDiscardedOnSendDelta ?? 0) > 0;
  const roundTripTimeMs = positive(measurement.roundTripTimeMs);
  const rttBad = roundTripTimeMs !== undefined
    && previous.lastRoundTripTimeMs !== undefined
    && roundTripTimeMs >= previous.lastRoundTripTimeMs * CLOUDFLARE_RTT_PRESSURE_GROWTH_RATIO
    && roundTripTimeMs - previous.lastRoundTripTimeMs >= CLOUDFLARE_RTT_PRESSURE_GROWTH_MS;
  const severe = fpsCollapsed && lossRatio !== undefined && lossRatio >= CLOUDFLARE_SEVERE_LOSS_RATIO;
  const frameRateAffected = fps !== undefined && targetFps !== undefined
    && fps < targetFps * CLOUDFLARE_HEALTHY_FPS_RATIO;
  const encoderTargetBps = positive(measurement.encoderTargetBitrateBps);
  const encoderTargetAffected = encoderTargetBps !== undefined
    && encoderTargetBps < previous.profileTargetBitrateBps * CLOUDFLARE_ENCODER_PRESSURE_RATIO;
  const outputAffected = frameRateAffected || encoderTargetAffected;
  const pressure = outputAffected && (bandwidthLimited || lossBad || discardsBad || rttBad);
  const healthy = !pressure && !bandwidthLimited && !cpuLimited
    && !rttBad
    && measurement.qualityLimitationReason !== undefined
    && !lossBad && !discardsBad;
  const hasMediaEvidence = measurement.qualityLimitationReason !== undefined || fps !== undefined;

  // Missing stats hold the counters instead of counting as healthy or pressured.
  let healthySamples = hasMediaEvidence
    ? (healthy ? previous.healthySamples + 1 : 0)
    : previous.healthySamples;
  const healthyRecoverySamples = hasMediaEvidence
    ? (healthy
      ? Math.min(previous.healthyRecoverySamples + 1, CLOUDFLARE_RECOVERY_HEALTHY_SAMPLES)
      : 0)
    : previous.healthyRecoverySamples;
  let bandwidthPressureSamples = hasMediaEvidence
    ? (pressure ? previous.bandwidthPressureSamples + 1 : 0)
    : previous.bandwidthPressureSamples;

  let emergencyResolution = previous.emergencyResolution;
  if (healthyRecoverySamples >= CLOUDFLARE_RECOVERY_HEALTHY_SAMPLES) emergencyResolution = false;

  let hardResolutionProtection = previous.hardResolutionProtection;
  const outputShortSide = shortSide(measurement.frameWidth, measurement.frameHeight);
  if (outputShortSide !== undefined) {
    hardResolutionProtection = outputShortSide < CLOUDFLARE_EMERGENCY_SHORT_SIDE_PX;
  }

  let transportBitrateCapBps = currentCap;
  let lastStableBitrateBps = previous.lastStableBitrateBps;
  const corroborated = lowProbeSamples >= CLOUDFLARE_LOW_PROBE_SAMPLE_LIMIT
    && bandwidthPressureSamples >= CLOUDFLARE_PRESSURE_SAMPLE_LIMIT;

  if (corroborated && currentCap > CLOUDFLARE_TRANSPORT_MIN_BITRATE_BPS) {
    if (severe) emergencyResolution = true;
    const recentFloor = (lastStableBitrateBps ?? CLOUDFLARE_TRANSPORT_MIN_BITRATE_BPS)
      * CLOUDFLARE_TRANSPORT_DROP_LAST_STABLE_RATIO;
    transportBitrateCapBps = Math.max(
      currentCap * CLOUDFLARE_TRANSPORT_DROP_FLOOR_RATIO,
      Math.min(currentCap * CLOUDFLARE_TRANSPORT_DROP_CEILING_RATIO, recentFloor),
      CLOUDFLARE_TRANSPORT_MIN_BITRATE_BPS
    );
    bandwidthPressureSamples = 0;
    lowProbeSamples = 0;
    healthySamples = 0;
  } else {
    const stableCapacityBps = measurement.turnProbe.status === 'ready'
      ? positive(measurement.turnProbe.stableCapacityBps)
      : undefined;
    if (stableCapacityBps !== undefined
      && stableCapacityBps >= currentCap * CLOUDFLARE_TRANSPORT_RAISE_CAPACITY_RATIO
      && healthySamples >= CLOUDFLARE_HEALTHY_RAISE_SAMPLES) {
      transportBitrateCapBps = clamp(
        Math.min(
          currentCap * CLOUDFLARE_TRANSPORT_RAISE_RATIO,
          stableCapacityBps * CLOUDFLARE_TRANSPORT_RAISE_CAPACITY_HEADROOM
        ),
        currentCap,
        CLOUDFLARE_TRANSPORT_MAX_BITRATE_BPS
      );
      const sustainedBitrateBps = measurement.encoderTargetBitrateBps ?? measurement.actualOutgoingBitrateBps;
      if (sustainedBitrateBps !== undefined) lastStableBitrateBps = sustainedBitrateBps;
      healthySamples = 0;
    }
  }

  const scaleResolutionDownBy = nextScale(input, previous, transportBitrateCapBps, emergencyResolution, healthyRecoverySamples);

  return {
    profileTargetBitrateBps: previous.profileTargetBitrateBps,
    transportBitrateCapBps,
    scaleResolutionDownBy,
    emergencyResolution,
    hardResolutionProtection,
    bandwidthPressureSamples,
    healthySamples,
    healthyRecoverySamples,
    lowProbeSamples,
    ...(probeWindow === undefined
      ? {}
      : { lastProbeSampledAt: measurement.turnProbe.sampledAt }),
    ...(lastStableBitrateBps === undefined ? {} : { lastStableBitrateBps }),
    ...(roundTripTimeMs === undefined && previous.lastRoundTripTimeMs === undefined
      ? {}
      : { lastRoundTripTimeMs: roundTripTimeMs ?? previous.lastRoundTripTimeMs })
  };
}

/** Shorter capture-source side, or undefined when the dimensions are unknown. */
export function computeCloudflareSourceShortSide(
  settings: { width?: number; height?: number }
): number | undefined {
  return shortSide(settings.width, settings.height);
}

/**
 * Maximum sampling scale that keeps the source's shorter side at or above the
 * 720p normal floor, or the 540p emergency floor.
 */
export function computeCloudflareMaximumScale(
  settings: { width?: number; height?: number },
  emergency = false
): number {
  const width = positive(settings.width);
  const height = positive(settings.height);
  if (width === undefined || height === undefined) return CLOUDFLARE_UNKNOWN_SOURCE_MAX_SCALE;
  const floor = emergency ? CLOUDFLARE_EMERGENCY_SHORT_SIDE_PX : CLOUDFLARE_NORMAL_SHORT_SIDE_PX;
  return Math.max(1, Math.min(width, height) / floor);
}

function nextScale(
  input: CloudflareEncodingUpdate,
  previous: CloudflareEncodingState,
  transportBitrateCapBps: number,
  emergencyResolution: boolean,
  healthyRecoverySamples: number
): number {
  const effectiveBudgetBps = Math.min(previous.profileTargetBitrateBps, transportBitrateCapBps);
  let idealScale = Math.max(1, Math.sqrt(previous.profileTargetBitrateBps / effectiveBudgetBps));
  const maximumScale = Math.max(
    1,
    Math.min(
      input.sourceShortSide === undefined
        ? CLOUDFLARE_UNKNOWN_SOURCE_MAX_SCALE
        : input.sourceShortSide / (emergencyResolution
          ? CLOUDFLARE_EMERGENCY_SHORT_SIDE_PX
          : CLOUDFLARE_NORMAL_SHORT_SIDE_PX),
      CLOUDFLARE_MAX_SCALE_RESOLUTION_DOWN_BY
    )
  );
  idealScale = clamp(idealScale, 1, maximumScale);

  // Keep the prior scale when leaving the emergency layer so recovery is
  // gradual. Clamping it to the new normal maximum here would create a large
  // one-sample resolution jump and violate the 5% recovery slew limit.
  const current = clamp(previous.scaleResolutionDownBy, 1, CLOUDFLARE_MAX_SCALE_RESOLUTION_DOWN_BY);
  if (idealScale > current) {
    // Sampling up (fewer pixels) is capped at 10% per sample.
    return clamp(Math.min(idealScale, current * (1 + CLOUDFLARE_MAX_SCALE_INCREASE_STEP)), 1, maximumScale);
  }
  // Resolution recovery waits for sustained health and is capped at 5%.
  if (idealScale < current && healthyRecoverySamples >= CLOUDFLARE_RECOVERY_HEALTHY_SAMPLES) {
    return clamp(Math.max(idealScale, current * (1 - CLOUDFLARE_MAX_SCALE_RECOVERY_STEP)), 1, CLOUDFLARE_MAX_SCALE_RESOLUTION_DOWN_BY);
  }
  return current;
}

/** Returns the window's measured capacity when it has not been counted yet. */
function readNewProbeWindow(
  previous: CloudflareEncodingState,
  turnProbe: TurnPathProbeSnapshot
): { measuredBps: number; offeredBps: number } | undefined {
  if (turnProbe.status !== 'ready' && turnProbe.status !== 'probing') return undefined;
  const sampledAt = finite(turnProbe.sampledAt);
  if (sampledAt === undefined || sampledAt === previous.lastProbeSampledAt) return undefined;
  const measuredBps = finite(turnProbe.measuredCapacityBps) ?? finite(turnProbe.stableCapacityBps);
  const offeredBps = finite(turnProbe.offeredBps);
  return measuredBps === undefined || offeredBps === undefined ? undefined : { measuredBps, offeredBps };
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function shortSide(width: number | undefined, height: number | undefined): number | undefined {
  const w = positive(width);
  const h = positive(height);
  if (w === undefined || h === undefined) return undefined;
  return Math.min(w, h);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
