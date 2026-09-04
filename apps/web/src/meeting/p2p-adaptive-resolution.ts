const BANDWIDTH_MIN_BITRATE_BPS = 1_000_000;
const PROBE_GROWTH = 1.15;
const HEALTHY_SAMPLE_LIMIT = 2;
const CONGESTED_SAMPLE_LIMIT = 3;
const HEALTHY_FPS_RATIO = 0.85;
const MAX_SCALE_STEP = 0.10;

export interface P2pAdaptiveResolutionMeasurement {
  availableOutgoingBitrateBps?: number;
  actualOutgoingBitrateBps?: number;
  qualityLimitationReason?: string;
  framesPerSecond?: number;
  targetFrameRate?: number;
}

export interface P2pAdaptiveResolutionState {
  scaleResolutionDownBy: number;
  healthySamples: number;
  congestedSamples: number;
}

export interface P2pAdaptiveResolutionUpdate {
  previous: P2pAdaptiveResolutionState;
  measurement: P2pAdaptiveResolutionMeasurement;
  referenceBitrateBps: number;
  minimumScaleResolutionDownBy: number;
  maximumScaleResolutionDownBy: number;
}

export function createP2pAdaptiveResolutionState(
  scaleResolutionDownBy: number
): P2pAdaptiveResolutionState {
  return {
    scaleResolutionDownBy: Math.max(1, scaleResolutionDownBy),
    healthySamples: 0,
    congestedSamples: 0
  };
}

/** Keeps a known source at or above a 720px short side; never upscales it. */
export function computeP2pMaximumScale(settings: { width?: number; height?: number }): number {
  const width = positive(settings.width);
  const height = positive(settings.height);
  if (width === undefined || height === undefined) return 1.5;
  return Math.max(1, Math.min(width, height) / 720);
}

/**
 * Adjusts only the explicit sampling scale for direct/coturn motion profiles.
 * The selected bitrate remains a cap; low RTC estimates or quiet desktop
 * content cannot lower it and therefore cannot create a self-limiting loop.
 */
export function updateP2pAdaptiveResolution(
  input: P2pAdaptiveResolutionUpdate
): P2pAdaptiveResolutionState {
  const rtcEstimate = positive(input.measurement.availableOutgoingBitrateBps);
  const actualBitrate = positive(input.measurement.actualOutgoingBitrateBps);
  const targetFrameRate = positive(input.measurement.targetFrameRate);
  const framesPerSecond = positive(input.measurement.framesPerSecond);
  const hasEvidence = rtcEstimate !== undefined
    || actualBitrate !== undefined
    || input.measurement.qualityLimitationReason !== undefined
    || framesPerSecond !== undefined;
  if (!hasEvidence) return input.previous;

  const fpsHealthy = targetFrameRate !== undefined
    && framesPerSecond !== undefined
    && framesPerSecond >= targetFrameRate * HEALTHY_FPS_RATIO;
  const fpsCollapsed = targetFrameRate !== undefined
    && framesPerSecond !== undefined
    && framesPerSecond < targetFrameRate * HEALTHY_FPS_RATIO;
  const bandwidthLimited = input.measurement.qualityLimitationReason === 'bandwidth';
  const frameRateStruggling = fpsCollapsed
    && actualBitrate !== undefined
    && actualBitrate < input.referenceBitrateBps;
  const healthy = (actualBitrate !== undefined || rtcEstimate !== undefined)
    && fpsHealthy
    && !bandwidthLimited;
  const congested = (bandwidthLimited || frameRateStruggling)
    && (fpsCollapsed || framesPerSecond === undefined);

  let healthySamples = healthy ? input.previous.healthySamples + 1 : 0;
  let congestedSamples = congested ? input.previous.congestedSamples + 1 : 0;
  let scaleResolutionDownBy = clamp(
    input.previous.scaleResolutionDownBy,
    input.minimumScaleResolutionDownBy,
    input.maximumScaleResolutionDownBy
  );

  if (congestedSamples >= CONGESTED_SAMPLE_LIMIT) {
    const supportedBitrate = actualBitrate ?? rtcEstimate ?? BANDWIDTH_MIN_BITRATE_BPS;
    const desiredBitrate = Math.max(BANDWIDTH_MIN_BITRATE_BPS, supportedBitrate * PROBE_GROWTH);
    const desiredScale = clamp(
      input.minimumScaleResolutionDownBy
        * Math.sqrt(input.referenceBitrateBps / Math.max(desiredBitrate, 1)),
      input.minimumScaleResolutionDownBy,
      input.maximumScaleResolutionDownBy
    );
    scaleResolutionDownBy = moveScale(scaleResolutionDownBy, desiredScale);
    congestedSamples = 0;
    healthySamples = 0;
  } else if (healthySamples >= HEALTHY_SAMPLE_LIMIT) {
    scaleResolutionDownBy = moveScale(
      scaleResolutionDownBy,
      input.minimumScaleResolutionDownBy
    );
    healthySamples = 0;
  }

  return { scaleResolutionDownBy, healthySamples, congestedSamples };
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function moveScale(current: number, desired: number): number {
  const maximumDelta = Math.max(0.01, current * MAX_SCALE_STEP);
  return current + Math.sign(desired - current) * Math.min(Math.abs(desired - current), maximumDelta);
}
