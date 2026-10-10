import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { h264Codec, ProjectVideoCodec } from './codec.js';
afterEach(() => vi.unstubAllGlobals());
it('derives profile/constraint/level from actual SPS and refuses packets without configuration', () => {
  expect(h264Codec(new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x2a]))).toBe('avc1.42c02a');
  expect(() => h264Codec(new Uint8Array([0, 0, 0, 1, 0x65, 0, 0, 0]))).toThrow();
});
it('fails clearly when project resources are missing, without using a browser encoder', async () => {
  vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
  const codec = new ProjectVideoCodec({ codec: 'h264', width: 1920, height: 1080, fps: 60, bitrate: 8000000, threads: 1 });
  await expect(codec.initialize()).rejects.toThrow('unavailable');
  await codec.close();
});
it('rejects modified module bytes before executing downloaded code', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', async (url: string) => url.includes('manifest.json')
    ? new Response(JSON.stringify({ releaseReady: true, artifacts: {
      'encoder-single.mjs': { sha256: '0'.repeat(64), bytes: 4 }, 'encoder-single.wasm': { sha256: '0'.repeat(64), bytes: 4 }
    } })) : new Response(new Uint8Array([1, 2, 3, 4])));
  const codec = new ProjectVideoCodec({ codec: 'h264', width: 1920, height: 1080, fps: 60, bitrate: 8000000, threads: 1 });
  await expect(codec.initialize()).rejects.toThrow('hash mismatch');
  await codec.close();
});
it('closes threaded VP8 through the runtime thread registry instead of obsolete wrapper worker lists', async () => {
  const terminateAllThreads = vi.fn();
  const obsoleteTerminate = vi.fn(() => { throw new TypeError('runningWorkers is undefined'); });
  const codec = new ProjectVideoCodec({ codec: 'vp8', width: 640, height: 360, fps: 60, bitrate: 1000000, threads: 4 });
  Object.assign(codec, { libav: { PThread: { terminateAllThreads }, terminate: obsoleteTerminate } });
  await expect(codec.close()).resolves.toBeUndefined();
  expect(terminateAllThreads).toHaveBeenCalledOnce();
  expect(obsoleteTerminate).not.toHaveBeenCalled();
});
