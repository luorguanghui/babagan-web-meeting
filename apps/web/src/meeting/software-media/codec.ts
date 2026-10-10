import { vp8EncoderOptions } from '../../../../../media/codec-options.mjs';
export interface LibavModule {
  ff_init_encoder(name: string, options: unknown): Promise<[number, number, number, number, number]>;
  ff_encode_multi(ctx: number, frame: number, packet: number, inputs: unknown[]): Promise<Array<{ data: Uint8Array; flags: number }>>;
  ff_free_encoder(ctx: number, frame: number, packet: number): Promise<void>;
  AV_SAMPLE_FMT_FLT: number;
  terminate(): void;
}
interface H264Module {
  HEAPU8: Uint8Array;
  PThread?: { terminateAllThreads(): void };
  _screen_create_video(w: number, h: number, fps: number, bitrate: number, threads: number): number;
  _screen_input(handle: number): number;
  _screen_encode(handle: number, timestamp: number, keyframe: number): number;
  _screen_output(handle: number): number;
  _screen_size(handle: number): number;
  _screen_key(handle: number): number;
  _screen_filter(handle: number): number;
  _screen_set_bitrate(handle: number, bitrate: number): number;
  _screen_destroy(handle: number): void;
}
interface Manifest { releaseReady: boolean; artifacts: Record<string, { sha256: string; bytes: number }>; }
async function verified(url: string, sha: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error('Project codec resource is unavailable');
  const bytes = await response.arrayBuffer();
  const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== sha) throw new Error('Project codec resource hash mismatch');
  return new Uint8Array(bytes);
}
async function resources(packageName: string, script: string, wasm: string): Promise<{ url: string; scriptBytes: Uint8Array<ArrayBuffer>; bytes: Uint8Array<ArrayBuffer> }> {
  const base = '/screen-codecs/' + packageName + '/';
  const response = await fetch(base + 'manifest.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('Project codec manifest is unavailable');
  const manifest = await response.json() as Manifest;
  const jsRecord = manifest.artifacts?.[script], wasmRecord = manifest.artifacts?.[wasm];
  if (!manifest.releaseReady || !jsRecord || !wasmRecord) throw new Error('Project codec package is not ready');
  const url = base + script + '?sha=' + jsRecord.sha256;
  const scriptBytes = await verified(url, jsRecord.sha256);
  return { url, scriptBytes, bytes: await verified(base + wasm + '?sha=' + wasmRecord.sha256, wasmRecord.sha256) };
}
async function importVerified(files: { url: string; scriptBytes: Uint8Array<ArrayBuffer> }): Promise<unknown> {
  const original = new URL(files.url, globalThis.location.href).href;
  const source = new TextDecoder().decode(files.scriptBytes).replaceAll('import.meta.url', JSON.stringify(original));
  const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try { return await import(/* @vite-ignore */ blob); } finally { URL.revokeObjectURL(blob); }
}
export async function loadLibav(threads: number): Promise<LibavModule> {
  const prefix = 'libav-6.10.9.0-vp8-opus', mode = threads > 1 && crossOriginIsolated ? 'thr' : 'wasm';
  const target = await resources('libav-6.10.9', `${prefix}.${mode}.mjs`, `${prefix}.${mode}.wasm`);
  const wrapper = await resources('libav-6.10.9', `${prefix}.mjs`, `${prefix}.${mode}.wasm`);
  const factory = await importVerified(target) as { default: (options: unknown) => Promise<unknown> };
  const library = await importVerified(wrapper) as { LibAV: (options: unknown) => Promise<LibavModule> };
  return library.LibAV({ noworker: true, yesthreads: mode === 'thr', nothreads: mode !== 'thr',
    factory: (options: Record<string, unknown>) => factory.default({ ...options, wasmBinary: target.bytes }) });
}
export function h264Codec(data: Uint8Array): string {
  for (let index = 4; index + 3 < data.length; index++) {
    if ((data[index] & 31) === 7 && data[index - 1] === 1 && data[index - 2] === 0 && data[index - 3] === 0) {
      return 'avc1.' + [...data.subarray(index + 1, index + 4)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
  }
  throw new Error('No SPS in H264 keyframe');
}
export class ProjectVideoCodec {
  private module?: H264Module;
  private handle = 0;
  private libav?: LibavModule;
  private encoder?: [number, number, number, number, number];
  private stopped = false;
  filter = 1;
  codecString = '';
  constructor(readonly options: { codec: 'h264' | 'vp8'; width: number; height: number; fps: number; bitrate: number; threads: number }) {}
  async initialize(): Promise<void> {
    if (this.options.codec === 'h264') {
      const mode = this.options.threads > 1 && crossOriginIsolated ? 'threads' : 'single';
      const files = await resources('openh264-2.6.0', `encoder-${mode}.mjs`, `encoder-${mode}.wasm`);
      const imported = await importVerified(files) as { default: (options: unknown) => Promise<H264Module> };
      this.module = await imported.default({ wasmBinary: files.bytes });
      if (this.stopped) { this.module.PThread?.terminateAllThreads(); return; }
      this.handle = this.module._screen_create_video(this.options.width, this.options.height, this.options.fps, this.options.bitrate, mode === 'single' ? 1 : this.options.threads);
      if (!this.handle) throw new Error('Project H264 initialization failed');
    } else {
      this.libav = await loadLibav(this.options.threads);
      if (this.stopped) { this.libav.terminate(); return; }
      this.encoder = await this.libav.ff_init_encoder('libvpx', vp8EncoderOptions(this.options));
      this.codecString = 'vp8';
    }
  }
  async setBitrate(bps: number): Promise<void> {
    if (!Number.isSafeInteger(bps) || bps < 100000 || bps > 40000000) throw new Error('Invalid project bitrate');
    if (bps === this.options.bitrate) return;
    this.options.bitrate = bps;
    if (this.module && this.module._screen_set_bitrate(this.handle, bps) !== 0) throw new Error('Project bitrate update failed');
    if (this.libav && this.encoder) {
      const old = this.encoder; this.encoder = undefined;
      await this.libav.ff_free_encoder(old[1], old[2], old[3]);
      this.encoder = await this.libav.ff_init_encoder('libvpx', vp8EncoderOptions(this.options));
    }
  }
  async encode(data: Uint8Array, timestampUs: number, forceKey: boolean): Promise<{ data: Uint8Array<ArrayBuffer>; keyframe: boolean } | null> {
    if (this.stopped) return null;
    if (this.module) {
      this.module.HEAPU8.set(data, this.module._screen_input(this.handle));
      const result = this.module._screen_encode(this.handle, timestampUs / 1000, forceKey ? 1 : 0);
      if (result < 0) throw new Error(`Project H264 failed (${result})`);
      if (result === 0) return null;
      const packet = this.module.HEAPU8.slice(this.module._screen_output(this.handle), this.module._screen_output(this.handle) + this.module._screen_size(this.handle));
      const key = this.module._screen_key(this.handle) === 1;
      if (key) this.codecString = h264Codec(packet);
      this.filter = this.module._screen_filter(this.handle);
      return { data: packet, keyframe: key };
    }
    if (!this.libav || !this.encoder) throw new Error('Project VP8 is not initialized');
    const { width, height } = this.options;
    const packets = await this.libav.ff_encode_multi(this.encoder[1], this.encoder[2], this.encoder[3], [{
      data, format: 0, width, height, pts: timestampUs % 0x100000000, ptshi: Math.floor(timestampUs / 0x100000000),
      time_base_num: 1, time_base_den: 1000000, pict_type: forceKey ? 1 : 0,
      layout: [{ offset: 0, stride: width }, { offset: width * height, stride: width / 2 }, { offset: width * height * 1.25, stride: width / 2 }]
    }]);
    if (!packets.length) return null;
    return { data: packets[0].data.slice(), keyframe: !!(packets[0].flags & 1) };
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.module && this.handle) { this.module._screen_destroy(this.handle); this.handle = 0; }
    this.module?.PThread?.terminateAllThreads();
    if (this.libav && this.encoder) {
      const old = this.encoder; this.encoder = undefined;
      await this.libav.ff_free_encoder(old[1], old[2], old[3]);
    }
    this.libav?.terminate();
  }
}
