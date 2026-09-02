export const CLOUDFLARE_UPLINK_PROBE_ENDPOINT = 'https://speed.cloudflare.com/__up';
export const CLOUDFLARE_UPLINK_PROBE_INTERVAL_MS = 60_000;
export const CLOUDFLARE_UPLINK_PROBE_TIMEOUT_MS = 15_000;

const WARMUP_BYTES = 64 * 1_024;
const INITIAL_SAMPLE_BYTES = 512 * 1_024;
const MIN_SAMPLE_BYTES = 256 * 1_024;
const MAX_SAMPLE_BYTES = 4 * 1_024 * 1_024;
const TARGET_SAMPLE_DURATION_MS = 1_500;

export interface CloudflareUplinkProbeResult {
  bitrateBps: number;
  sampleCount: number;
}

export interface CloudflareUplinkProbeOptions {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  now?: () => number;
}

/** Actively uploads bounded payloads to Cloudflare's public speed-test edge. */
export async function measureCloudflareUplink(
  options: CloudflareUplinkProbeOptions = {}
): Promise<CloudflareUplinkProbeResult> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => performance.now());
  const timeoutSignal = AbortSignal.timeout(CLOUDFLARE_UPLINK_PROBE_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  await uploadSample(WARMUP_BYTES, fetcher, now, signal);
  const first = await uploadSample(INITIAL_SAMPLE_BYTES, fetcher, now, signal);
  const adaptiveBytes = clamp(
    Math.round(first.bitrateBps * TARGET_SAMPLE_DURATION_MS / 8_000),
    MIN_SAMPLE_BYTES,
    MAX_SAMPLE_BYTES
  );
  const second = await uploadSample(adaptiveBytes, fetcher, now, signal);
  const samples = [first.bitrateBps, second.bitrateBps].sort((left, right) => left - right);

  return {
    bitrateBps: (samples[0] + samples[1]) / 2,
    sampleCount: samples.length
  };
}

async function uploadSample(
  bytes: number,
  fetcher: typeof fetch,
  now: () => number,
  signal?: AbortSignal
): Promise<{ bitrateBps: number }> {
  const body = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
  const startedAt = now();
  const response = await fetcher(CLOUDFLARE_UPLINK_PROBE_ENDPOINT, {
    method: 'POST',
    body,
    cache: 'no-store',
    ...(signal ? { signal } : {})
  });
  const durationMs = now() - startedAt;
  if (!response.ok || !Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Cloudflare upload probe failed');
  }
  return { bitrateBps: bytes * 8_000 / durationMs };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
