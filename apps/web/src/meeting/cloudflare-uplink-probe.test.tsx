import { describe, expect, it, vi } from 'vitest';

import {
  CLOUDFLARE_UPLINK_PROBE_ENDPOINT,
  measureCloudflareUplink
} from './cloudflare-uplink-probe.js';

describe('Cloudflare uplink probe', () => {
  it('warms the connection, adapts the second payload, and reports measured upload bps', async () => {
    const times = [0, 100, 100, 500, 500, 2_000];
    const bodySizes: number[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(CLOUDFLARE_UPLINK_PROBE_ENDPOINT);
      expect(init).toEqual(expect.objectContaining({ method: 'POST', cache: 'no-store' }));
      bodySizes.push((init?.body as Blob).size);
      return new Response(null, { status: 200 });
    });

    const result = await measureCloudflareUplink({
      fetcher,
      now: () => times.shift() ?? 2_000
    });

    expect(bodySizes[0]).toBe(64 * 1_024);
    expect(bodySizes[1]).toBe(512 * 1_024);
    expect(bodySizes[2]).toBeGreaterThan(bodySizes[1]);
    expect(bodySizes[2]).toBeLessThanOrEqual(4 * 1_024 * 1_024);
    expect(result.bitrateBps).toBeCloseTo(10_485_760, -3);
    expect(result.sampleCount).toBe(2);
  });

  it('rejects a failed upload instead of presenting it as zero bandwidth', async () => {
    await expect(measureCloudflareUplink({
      fetcher: vi.fn(async () => new Response(null, { status: 503 })),
      now: () => 0
    })).rejects.toThrow('Cloudflare upload probe failed');
  });
});
