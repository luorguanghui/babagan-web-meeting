export const CLOUDFLARE_ADAPTATION_HEADROOM = 0.85;
export const CLOUDFLARE_ADAPTATION_MIN_BITRATE_BPS = 1_000_000;
export const CLOUDFLARE_ADAPTATION_MAX_BITRATE_BPS = 50_000_000;
export const CLOUDFLARE_ADAPTATION_BANDWIDTH_SMOOTHING = 0.25;
export const CLOUDFLARE_ADAPTATION_MAX_BITRATE_STEP = 0.2;
export const CLOUDFLARE_ADAPTATION_MAX_SCALE_STEP = 0.1;
export const CLOUDFLARE_ADAPTATION_MAX_SCALE_RESOLUTION_DOWN_BY = 4;
export const CLOUDFLARE_PROBE_INITIAL_BITRATE_BPS = 10_000_000;
export const CLOUDFLARE_PROBE_GROWTH = 1.15;
export const CLOUDFLARE_PROBE_HEALTHY_SAMPLE_LIMIT = 2;
export const CLOUDFLARE_PROBE_CONGESTED_SAMPLE_LIMIT = 3;
export const CLOUDFLARE_PROBE_HEALTHY_FPS_RATIO = 0.85;

export type CloudflareProbeStatus = 'probing' | 'stable' | 'constrained';

export interface CloudflareEncodingMeasurement {
  /** Advisory congestion estimate, retained for diagnostics but never trusted alone for backoff. */
  availableOutgoingBitrateBps?: number;
  /** Actual outbound video bitrate calculated from successive RTP samples. */
  actualOutgoingBitrateBps?: number;
  /** Independent bounded upload measurement against Cloudflare's speed-test edge. */
  testedCloudflareUplinkBitrateBps?: number;
  qualityLimitationReason?: string;
  framesPerSecond?: number;
  targetFrameRate?: number;
}

export interface CloudflareEncodingState {
  bandwidthEstimateBps?: number;
  testedCloudflareUplinkBitrateBps?: number;
  trustedAvailableOutgoingBitrateBps?: number;
  targetBitrateBps: number;
  scaleResolutionDownBy: number;
  probeStatus?: CloudflareProbeStatus;
  healthySamples?: number;
  congestedSamples?: number;
}

export interface CloudflareEncodingUpdate {
  previous: CloudflareEncodingState;
  measurement: CloudflareEncodingMeasurement;
  minimumScaleResolutionDownBy: number;
  maximumScaleResolutionDownBy?: number;
  referenceBitrateBps?: number;
}

/**
 * Probes upward and backs off only after sustained sender-side congestion.
 * A low RTC estimate alone can be caused by the existing sender cap, so it
 * must not create a self-fulfilling low-bitrate loop.
 */
export function updateCloudflareEncoding(input: CloudflareEncodingUpdate): CloudflareEncodingState {
  const rtcEstimate = positive(input.measurement.availableOutgoingBitrateBps);
  const actualBitrate = positive(input.measurement.actualOutgoingBitrateBps);
  const testedUplink = positive(input.measurement.testedCloudflareUplinkBitrateBps);
  const hasEvidence = rtcEstimate !== undefined
    || actualBitrate !== undefined
    || testedUplink !== undefined
    || input.measurement.qualityLimitationReason !== undefined
    || input.measurement.framesPerSecond !== undefined;
  if (!hasEvidence) return input.previous;

  const bandwidthEstimateBps = rtcEstimate === undefined
    ? input.previous.bandwidthEstimateBps
    : input.previous.bandwidthEstimateBps === undefined
      ? rtcEstimate
      : input.previous.bandwidthEstimateBps
        + (rtcEstimate - input.previous.bandwidthEstimateBps) * CLOUDFLARE_ADAPTATION_BANDWIDTH_SMOOTHING;
  const testedCloudflareUplinkBitrateBps = testedUplink ?? input.previous.testedCloudflareUplinkBitrateBps;
  const targetFrameRate = positive(input.measurement.targetFrameRate);
  const fps = positive(input.measurement.framesPerSecond);
  const fpsHealthy = targetFrameRate !== undefined
    && fps !== undefined
    && fps >= targetFrameRate * CLOUDFLARE_PROBE_HEALTHY_FPS_RATIO;
  const fpsCollapsed = targetFrameRate !== undefined
    && fps !== undefined
    && fps < targetFrameRate * CLOUDFLARE_PROBE_HEALTHY_FPS_RATIO;
  const bandwidthLimited = input.measurement.qualityLimitationReason === 'bandwidth';
  const healthy = actualBitrate !== undefined && fpsHealthy && !bandwidthLimited;
  const congested = bandwidthLimited && (fpsCollapsed || fps === undefined);

  let healthySamples = healthy ? (input.previous.healthySamples ?? 0) + 1 : 0;
  let congestedSamples = congested ? (input.previous.congestedSamples ?? 0) + 1 : 0;
  let probeStatus = input.previous.probeStatus ?? 'probing';
  let targetBitrateBps = input.previous.targetBitrateBps;
  let trustedAvailableOutgoingBitrateBps = input.previous.trustedAvailableOutgoingBitrateBps;
  let scaleResolutionDownBy = Math.max(
    input.minimumScaleResolutionDownBy,
    input.previous.scaleResolutionDownBy
  );

  if (probeStatus !== 'constrained') {
    targetBitrateBps = Math.max(targetBitrateBps, CLOUDFLARE_PROBE_INITIAL_BITRATE_BPS);
  }
  const hasNewTestedUplink = testedUplink !== undefined
    && testedUplink !== input.previous.testedCloudflareUplinkBitrateBps;
  const testedTargetBitrateBps = testedCloudflareUplinkBitrateBps === undefined
    ? undefined
    : clamp(
      testedCloudflareUplinkBitrateBps * CLOUDFLARE_ADAPTATION_HEADROOM,
      CLOUDFLARE_ADAPTATION_MIN_BITRATE_BPS,
      CLOUDFLARE_ADAPTATION_MAX_BITRATE_BPS
    );
  let testedUplinkConstrained = false;
  if (testedTargetBitrateBps !== undefined && testedTargetBitrateBps < targetBitrateBps) {
    targetBitrateBps = moveNumber(
      targetBitrateBps,
      testedTargetBitrateBps,
      CLOUDFLARE_ADAPTATION_MAX_BITRATE_STEP
    );
    scaleResolutionDownBy = moveScaleForBitrate(input, scaleResolutionDownBy, testedTargetBitrateBps);
    testedUplinkConstrained = true;
  } else if (hasNewTestedUplink && testedTargetBitrateBps !== undefined) {
    targetBitrateBps = Math.max(targetBitrateBps, testedTargetBitrateBps);
    scaleResolutionDownBy = moveScale(scaleResolutionDownBy, input.minimumScaleResolutionDownBy);
  }

  if (healthy) {
    trustedAvailableOutgoingBitrateBps = Math.max(
      trustedAvailableOutgoingBitrateBps ?? 0,
      actualBitrate
    );
    if (healthySamples >= CLOUDFLARE_PROBE_HEALTHY_SAMPLE_LIMIT) {
      const desiredProbeBitrate = testedTargetBitrateBps ?? targetBitrateBps * CLOUDFLARE_PROBE_GROWTH;
      targetBitrateBps = clamp(
        Math.max(targetBitrateBps, desiredProbeBitrate),
        CLOUDFLARE_ADAPTATION_MIN_BITRATE_BPS,
        CLOUDFLARE_ADAPTATION_MAX_BITRATE_BPS
      );
      healthySamples = 0;
      probeStatus = 'stable';
      scaleResolutionDownBy = moveScale(scaleResolutionDownBy, input.minimumScaleResolutionDownBy);
    }
  } else if (!testedUplinkConstrained
    && congestedSamples >= CLOUDFLARE_PROBE_CONGESTED_SAMPLE_LIMIT) {
    const supportedBitrate = actualBitrate
      ?? trustedAvailableOutgoingBitrateBps
      ?? CLOUDFLARE_ADAPTATION_MIN_BITRATE_BPS;
    const desiredBitrateBps = clamp(
      supportedBitrate * CLOUDFLARE_PROBE_GROWTH,
      CLOUDFLARE_ADAPTATION_MIN_BITRATE_BPS,
      CLOUDFLARE_ADAPTATION_MAX_BITRATE_BPS
    );
    targetBitrateBps = moveNumber(
      targetBitrateBps,
      Math.min(targetBitrateBps, desiredBitrateBps),
      CLOUDFLARE_ADAPTATION_MAX_BITRATE_STEP
    );
    scaleResolutionDownBy = moveScaleForBitrate(input, scaleResolutionDownBy, desiredBitrateBps);
    congestedSamples = 0;
    probeStatus = 'constrained';
  }

  return {
    ...(bandwidthEstimateBps === undefined ? {} : { bandwidthEstimateBps }),
    ...(testedCloudflareUplinkBitrateBps === undefined ? {} : { testedCloudflareUplinkBitrateBps }),
    ...(trustedAvailableOutgoingBitrateBps === undefined ? {} : { trustedAvailableOutgoingBitrateBps }),
    targetBitrateBps,
    scaleResolutionDownBy,
    probeStatus,
    healthySamples,
    congestedSamples
  };
}

/** Returns the scale that keeps a known source's shorter side at least 720px. */
export function computeCloudflareMaximumScale(settings: { width?: number; height?: number }): number {
  const width = positive(settings.width);
  const height = positive(settings.height);
  if (width === undefined || height === undefined) return 1.5;
  return Math.max(1, Math.min(width, height) / 720);
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function moveNumber(current: number, desired: number, fraction: number): number {
  return current + (desired - current) * fraction;
}

function moveScaleForBitrate(
  input: CloudflareEncodingUpdate,
  currentScale: number,
  desiredBitrateBps: number
): number {
  const referenceBitrateBps = positive(input.referenceBitrateBps)
    ?? input.previous.targetBitrateBps;
  const minimumScale = Math.max(1, input.minimumScaleResolutionDownBy);
  const maximumScale = Math.max(
    minimumScale,
    input.maximumScaleResolutionDownBy ?? CLOUDFLARE_ADAPTATION_MAX_SCALE_RESOLUTION_DOWN_BY
  );
  const idealScale = clamp(
    currentScale * Math.sqrt(referenceBitrateBps / Math.max(desiredBitrateBps, 1)),
    minimumScale,
    maximumScale
  );
  return moveScale(currentScale, idealScale);
}

function moveScale(current: number, desired: number): number {
  const maxDelta = Math.max(0.01, current * CLOUDFLARE_ADAPTATION_MAX_SCALE_STEP);
  return current + Math.sign(desired - current) * Math.min(Math.abs(desired - current), maxDelta);
}
