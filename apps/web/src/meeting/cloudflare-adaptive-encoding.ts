export const CLOUDFLARE_ADAPTATION_HEADROOM = 0.85;
export const CLOUDFLARE_ADAPTATION_MIN_BITRATE_BPS = 1_000_000;
export const CLOUDFLARE_ADAPTATION_MAX_BITRATE_BPS = 50_000_000;
export const CLOUDFLARE_ADAPTATION_BANDWIDTH_SMOOTHING = 0.25;
export const CLOUDFLARE_ADAPTATION_MAX_BITRATE_STEP = 0.2;
export const CLOUDFLARE_ADAPTATION_MAX_SCALE_STEP = 0.1;
export const CLOUDFLARE_ADAPTATION_MAX_SCALE_RESOLUTION_DOWN_BY = 4;

export interface CloudflareEncodingMeasurement {
  /** WebRTC's estimated outbound capacity for the selected TURN candidate pair. */
  availableOutgoingBitrateBps?: number;
  /** Actual outbound video bitrate calculated from successive RTP samples. */
  actualOutgoingBitrateBps?: number;
}

export interface CloudflareEncodingState {
  bandwidthEstimateBps?: number;
  targetBitrateBps: number;
  scaleResolutionDownBy: number;
}

export interface CloudflareEncodingUpdate {
  previous: CloudflareEncodingState;
  measurement: CloudflareEncodingMeasurement;
  /** The fixed source-normalization scale, if the capture is already oversized. */
  minimumScaleResolutionDownBy: number;
}

/**
 * Moves one Cloudflare relay session toward its measured capacity. Both the
 * bitrate and the resolution scale are slew-limited so a noisy one-second
 * estimate cannot cause a visible frame-rate oscillation.
 */
export function updateCloudflareEncoding(input: CloudflareEncodingUpdate): CloudflareEncodingState {
  const measured = positive(input.measurement.availableOutgoingBitrateBps)
    ?? positive(input.measurement.actualOutgoingBitrateBps);
  if (measured === undefined) return input.previous;

  const bandwidthEstimateBps = input.previous.bandwidthEstimateBps === undefined
    ? measured
    : input.previous.bandwidthEstimateBps
      + (measured - input.previous.bandwidthEstimateBps) * CLOUDFLARE_ADAPTATION_BANDWIDTH_SMOOTHING;
  const desiredBitrateBps = clamp(
    bandwidthEstimateBps * CLOUDFLARE_ADAPTATION_HEADROOM,
    CLOUDFLARE_ADAPTATION_MIN_BITRATE_BPS,
    CLOUDFLARE_ADAPTATION_MAX_BITRATE_BPS
  );
  const targetBitrateBps = moveNumber(
    input.previous.targetBitrateBps,
    desiredBitrateBps,
    CLOUDFLARE_ADAPTATION_MAX_BITRATE_STEP
  );

  const minimumScale = Math.max(1, input.minimumScaleResolutionDownBy);
  const previousScale = Math.max(minimumScale, input.previous.scaleResolutionDownBy);
  const observedBitrateBps = positive(input.measurement.actualOutgoingBitrateBps)
    ?? input.previous.targetBitrateBps;
  const pixelLoadRatio = clamp(observedBitrateBps / Math.max(desiredBitrateBps, 1), 0.25, 4);
  const idealScale = clamp(
    previousScale * Math.sqrt(pixelLoadRatio),
    minimumScale,
    Math.max(minimumScale, CLOUDFLARE_ADAPTATION_MAX_SCALE_RESOLUTION_DOWN_BY)
  );
  const scaleResolutionDownBy = moveScale(previousScale, idealScale);

  return { bandwidthEstimateBps, targetBitrateBps, scaleResolutionDownBy };
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

function moveScale(current: number, desired: number): number {
  const maxDelta = Math.max(0.01, current * CLOUDFLARE_ADAPTATION_MAX_SCALE_STEP);
  return current + Math.sign(desired - current) * Math.min(Math.abs(desired - current), maxDelta);
}
