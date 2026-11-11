import { NATIVE_CAPTURE_HEADER_BYTES, NATIVE_CAPTURE_MAX_PIXELS, NATIVE_CAPTURE_PACKET_MAGIC,
  NATIVE_CAPTURE_PROTOCOL, type NativeCaptureCounters, type NativeCaptureFormat, type NativeCaptureSourceProof,
  type NativeCaptureSourcePolicy, type NativeCaptureStart } from '@meeting/contracts';
import { abortableCapture, captureAborted, stopCaptureStream } from './capture-abort.js';
import { NativeWorkerPacer, localNativePacer, type NativePacer } from './worker-pacer.js';

const storageKey = 'babagan.native-capture';
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
function packetLength(value: unknown): number {
  try { return arrayBufferLength.call(value) as number; } catch { return -1; }
}
const nativeTracks = new WeakSet<MediaStreamTrack>();
const nativePacing = new WeakMap<MediaStreamTrack, { pacer: NativePacer; channel?: NativeHttpChannel }>();
const nativeSources = new WeakMap<MediaStreamTrack, NativeCaptureSourceProof>();
export function isNativeCaptureTrack(track: MediaStreamTrack): boolean { return nativeTracks.has(track); }
export function registerNativeCaptureTrack(track: MediaStreamTrack): void { nativeTracks.add(track); }
export function getNativePacingStats(track: MediaStreamTrack) {
  const state = nativePacing.get(track);
  if (!state) return undefined;
  const pipeline = state.channel?.getDiagnostics();
  return { ...state.pacer.stats(), ...(pipeline ? { pipeline } : {}) };
}
export interface NativeCaptureConnection { port: number; token: string; }
function validConnection(value: unknown): value is NativeCaptureConnection {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<NativeCaptureConnection>;
  return Number.isInteger(config.port) && config.port! >= 1024 && config.port! <= 65535
    && typeof config.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(config.token);
}
export function readNativeCaptureConnection(storage?: Pick<Storage, 'getItem'>): NativeCaptureConnection | undefined {
  try { const value: unknown = JSON.parse((storage ?? sessionStorage).getItem(storageKey) ?? 'null'); return validConnection(value) ? value : undefined; }
  catch { return undefined; }
}
export function initializeNativeCaptureConnection(environment?: {
  href: string; storage: Storage; replace: (url: string) => void;
}): NativeCaptureConnection | undefined {
  const url = new URL(environment?.href ?? location.href);
  let storage: Storage | undefined;
  try { storage = environment?.storage ?? sessionStorage; } catch { /* Still scrub the capability below. */ }
  const hash = new URLSearchParams(url.hash.slice(1));
  if (hash.has('nativeCapture')) {
    const match = /^1\.(\d{4,5})\.([A-Za-z0-9_-]{43})$/.exec(hash.get('nativeCapture') ?? '');
    const config = match ? { port: Number(match[1]), token: match[2] } : undefined;
    try { if (validConnection(config)) storage?.setItem(storageKey, JSON.stringify(config)); else storage?.removeItem(storageKey); }
    catch { /* Restricted storage must not prevent the ordinary meeting from loading. */ }
    hash.delete('nativeCapture'); url.hash = hash.toString();
    (environment?.replace ?? (value => history.replaceState(history.state, '', value)))(url.pathname + url.search + url.hash);
  }
  return storage ? readNativeCaptureConnection(storage) : undefined;
}

export class NativeCaptureError extends Error {
  constructor(readonly code: 'unavailable' | 'unsupported-source' | 'protocol', message: string) { super(message); this.name = 'NativeCaptureError'; }
}
interface FrameWriter { write(frame: VideoFrame): Promise<unknown>; close(): Promise<unknown>; }
interface NativeFrameChannel extends EventTarget { binaryType: string; readyState: number; send(message: string): void; close(): void; }
interface NativeVideoDependencies {
  createSocket?: (url: string, protocols: string[]) => NativeFrameChannel;
  fetch?: typeof fetch;
  createFrame?: (bytes: Uint8Array<ArrayBuffer>, init: VideoFrameBufferInit) => VideoFrame;
  createTrackWriter?: () => { track: MediaStreamTrack; writer: FrameWriter };
  timeOrigin?: number;
  signal?: AbortSignal;
  sourcePolicy?: NativeCaptureSourcePolicy;
}
function createNativeGenerator(): MediaStreamTrack & { writable: WritableStream<VideoFrame> } {
  const Generator = (globalThis as unknown as {
    MediaStreamTrackGenerator?: new (options: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };
  }).MediaStreamTrackGenerator;
  if (!Generator) throw new NativeCaptureError('unavailable', 'This browser cannot receive native screen frames. Use current Edge.');
  return new Generator({ kind: 'video' });
}
function parseFormat(message: Record<string, unknown>, frameRate: number): NativeCaptureFormat {
  const width = Number(message.width), height = Number(message.height);
  if (message.format !== 'I420' || message.frameRate !== frameRate || !Number.isInteger(width) || !Number.isInteger(height)
    || width < 2 || height < 2 || width % 2 || height % 2 || width * height > NATIVE_CAPTURE_MAX_PIXELS) {
    throw new NativeCaptureError('protocol', 'Native capture returned an invalid video format.');
  }
  let source: NativeCaptureSourceProof | undefined;
  if (message.source !== undefined) {
    const value = message.source as Partial<NativeCaptureSourceProof> | null;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
      || value.kind !== 'sole-active-monitor' || value.activeDisplayCount !== 1 || value.outputIndex !== 0) {
      throw new NativeCaptureError('protocol', 'Native capture returned invalid source provenance.');
    }
    source = { kind: 'sole-active-monitor', activeDisplayCount: 1, outputIndex: 0 };
  }
  const statsId = typeof message.statsId === 'string' && /^[a-f0-9]{32}$/.test(message.statsId) ? message.statsId : undefined;
  return { type: 'format', format: 'I420', width, height, frameRate: frameRate as 30 | 60,
    ...(source ? { source } : {}), ...(statsId ? { statsId } : {}) };
}

function readCaptureDiagnostics(value: unknown): { at: number; counters: NativeCaptureCounters } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const count = (key: string) => {
    const number = row[key];
    return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
  };
  const { at } = row;
  const capturedFrames = count('capturedFrames'), sentFrames = count('sentFrames'), droppedFrames = count('droppedFrames');
  if (row.type !== 'stats' || typeof at !== 'number' || !Number.isFinite(at) || at < 0
    || capturedFrames === undefined || sentFrames === undefined || droppedFrames === undefined) return undefined;
  return { at, counters: { type: 'stats', capturedFrames, sentFrames, droppedFrames,
    dxgiFrames: count('dxgiFrames'), filteredFrames: count('filteredFrames'), contentChangedFrames: count('contentChangedFrames') } };
}

/** Streaming HTTP avoids the large-message WebSocket receive bottleneck in Edge. */
class NativeHttpChannel extends EventTarget implements NativeFrameChannel {
  binaryType = 'arraybuffer';
  readyState = 0;
  private started = false;
  private readonly abort = new AbortController();
  private reader?: ReadableStreamBYOBReader;
  private statsId?: string;
  private statsPending = false;
  private statsRequestedAt = -Infinity;
  private diagnostics?: { at: number; counters: NativeCaptureCounters };
  constructor(private readonly connection: NativeCaptureConnection, private readonly request: typeof fetch) {
    super();
    queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event('open')); } });
  }
  send(message: string): void {
    if (this.readyState !== 1) return;
    const command = JSON.parse(message) as NativeCaptureStart & { type: string };
    if (command.type === 'stop') { this.close(); return; }
    if (command.type !== 'start' || this.started) return;
    this.started = true;
    void this.receive(command).catch(error => {
      if (this.readyState === 3) return;
      this.dispatchEvent(new CustomEvent('error', { detail: error })); this.close();
    });
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3; this.abort.abort();
    void this.reader?.cancel().catch(() => undefined);
    this.dispatchEvent(new Event('close'));
  }
  getDiagnostics() {
    const now = performance.now();
    if (this.statsId && this.readyState === 1 && !this.statsPending && now - this.statsRequestedAt >= 800) {
      this.statsRequestedAt = now;
      this.statsPending = true;
      void this.readDiagnostics(this.statsId).finally(() => { this.statsPending = false; });
    }
    return this.diagnostics;
  }

  private async readDiagnostics(id: string): Promise<void> {
    try {
      const response = await this.request(`http://127.0.0.1:${this.connection.port}/capture-stats/${id}`, {
        method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(750)]),
        headers: { Authorization: `Bearer ${this.connection.token}` }
      });
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); return; }
      const diagnostics = readCaptureDiagnostics(await response.json());
      if (diagnostics && this.readyState === 1) this.diagnostics = diagnostics;
    } catch { /* A diagnostics error must not interrupt capture. */ }
  }

  private async readExact(length: number): Promise<ArrayBuffer> {
    let buffer = new ArrayBuffer(length), offset = 0;
    while (offset < length) {
      const chunk = await this.reader!.read(new Uint8Array(buffer, offset));
      if (chunk.done || !chunk.value?.byteLength) throw new NativeCaptureError('unavailable', 'Native capture stream ended.');
      // BYOB returns ownership of the same backing store, including previous bytes.
      buffer = chunk.value.buffer as ArrayBuffer; offset += chunk.value.byteLength;
    }
    return buffer;
  }
  private async receive({ frameRate, sourcePolicy }: NativeCaptureStart): Promise<void> {
    const response = await this.request(`http://127.0.0.1:${this.connection.port}/frames-http`, {
      method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', signal: this.abort.signal,
      headers: { Authorization: `Bearer ${this.connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ frameRate, ...(sourcePolicy ? { sourcePolicy } : {}) })
    });
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new NativeCaptureError(response.status === 422 || (sourcePolicy && response.status === 400) ? 'unsupported-source' : 'unavailable',
        sourcePolicy && response.status === 400 ? 'Update the native sharing component to verify this screen selection.' : 'Native capture request failed.');
    }
    this.reader = response.body.getReader({ mode: 'byob' });
    const prefix = new DataView(await this.readExact(4)).getUint32(0);
    if (prefix < 1 || prefix > 4096) throw new NativeCaptureError('protocol', 'Native capture metadata is invalid.');
    const message = JSON.parse(new TextDecoder().decode(await this.readExact(prefix))) as Record<string, unknown>;
    const format = parseFormat(message, frameRate);
    this.statsId = format.statsId;
    this.getDiagnostics();
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(format) }));
    const packetLength = NATIVE_CAPTURE_HEADER_BYTES + format.width * format.height * 3 / 2;
    while (this.readyState === 1) {
      const packet = await this.readExact(packetLength);
      if (this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data: packet }));
    }
  }
}
export function openNativeVideoTrack(connection: NativeCaptureConnection, frameRate: 30 | 60,
  deps: NativeVideoDependencies = {}): Promise<MediaStreamTrack> {
  return new Promise((resolve, reject) => {
    if (!validConnection(connection)) { reject(new NativeCaptureError('unavailable', 'Invalid native capture connection.')); return; }
    let track: MediaStreamTrack, originalStop: (() => void) | undefined, pacer: NativePacer | undefined;
    let socket: NativeFrameChannel | undefined, closed = false, ready = false;
    let format: NativeCaptureFormat | undefined;
    let sequence = -1, timestamp = -Infinity;
    const unavailable = () => new NativeCaptureError('unavailable', 'Reopen the native meeting launcher and allow local network access.');
    const cleanup = (error?: Error, signalEnded = false) => {
      if (closed) return;
      closed = true; clearTimeout(timer); void pacer?.close(); deps.signal?.removeEventListener('abort', abort);
      if (track) nativeSources.delete(track);
      if (socket?.readyState === 1) { try { socket.send(JSON.stringify({ type: 'stop' })); } catch { /* Already closed. */ } }
      socket?.close(); originalStop?.();
      if (!ready) reject(error ?? unavailable());
      if (signalEnded && ready) track.dispatchEvent(new Event('ended'));
    };
    const abort = () => cleanup(new DOMException('Native screen selection ended.', 'AbortError'), true);
    const timer = setTimeout(() => cleanup(unavailable()), 15_000);
    const delivery = { frameRate,
      delivered: () => { if (!closed && !ready) { ready = true; clearTimeout(timer); resolve(track); } },
      fail: (error: unknown) => cleanup(new NativeCaptureError('unavailable',
        `Native frame delivery failed: ${error instanceof Error ? error.message : String(error)}`), true) };
    if (deps.signal?.aborted) { abort(); return; }
    deps.signal?.addEventListener('abort', abort, { once: true });
    const connect = () => {
      if (closed) return;
      nativeTracks.add(track);
      track.stop = () => cleanup();
      try {
        socket = deps.createSocket
          ? deps.createSocket(`ws://127.0.0.1:${connection.port}/frames`, [NATIVE_CAPTURE_PROTOCOL, `auth.${connection.token}`])
          : new NativeHttpChannel(connection, deps.fetch ?? ((input, init) => globalThis.fetch(input, init)));
        nativePacing.set(track, { pacer: pacer!, channel: socket instanceof NativeHttpChannel ? socket : undefined });
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('open', () => { if (!closed) socket!.send(JSON.stringify({ type: 'start', frameRate,
          ...(deps.sourcePolicy ? { sourcePolicy: deps.sourcePolicy } : {}) })); });
        socket.addEventListener('error', event => cleanup(event instanceof CustomEvent && event.detail instanceof NativeCaptureError
          ? event.detail : unavailable(), true));
        socket.addEventListener('close', () => cleanup(unavailable(), true));
        socket.addEventListener('message', rawEvent => {
          const event = rawEvent as MessageEvent;
          if (closed) return;
          try {
            if (typeof event.data === 'string') {
              if (event.data.length > 4096) throw new NativeCaptureError('protocol', 'Native capture control message is too large.');
              const message = JSON.parse(event.data) as Record<string, unknown>;
              if (message.type === 'error' || message.type === 'stopped') {
                cleanup(message.code === 'UNSUPPORTED_SOURCE'
                  ? new NativeCaptureError('unsupported-source', 'Native capture currently requires one active primary display.')
                  : deps.sourcePolicy && message.code === 'invalid_control'
                    ? new NativeCaptureError('unsupported-source', 'Update the native sharing component to verify this screen selection.') : unavailable(), true);
                return;
              }
              if (message.type === 'format') {
                if (format) throw new NativeCaptureError('protocol', 'Native capture unexpectedly changed video format.');
                format = parseFormat(message, frameRate);
                if (deps.sourcePolicy && !format.source) throw new NativeCaptureError('unsupported-source', 'Native capture did not verify the selected monitor.');
                if (format.source) nativeSources.set(track, format.source);
                const getSettings = track.getSettings?.bind(track);
                track.getSettings = () => ({ ...getSettings?.(), width: format!.width, height: format!.height,
                  aspectRatio: format!.width / format!.height, frameRate });
              }
              return;
            }
            const buffer = event.data as ArrayBuffer;
            // Brand-check the internal buffer slot, including BYOB buffers from other realms.
            if (!format || packetLength(buffer) !== NATIVE_CAPTURE_HEADER_BYTES + format.width * format.height * 3 / 2) {
              throw new NativeCaptureError('protocol', 'Native capture frame has an invalid size.');
            }
            const header = new DataView(buffer), nextSequence = header.getUint32(4), nextTimestamp = header.getFloat64(8);
            if (header.getUint32(0) !== NATIVE_CAPTURE_PACKET_MAGIC || !Number.isSafeInteger(nextTimestamp) || nextTimestamp <= 0) {
              throw new NativeCaptureError('protocol', 'Native capture frame has an invalid timestamp or signature.');
            }
            if (nextSequence <= sequence || nextTimestamp <= timestamp) return;
            sequence = nextSequence; timestamp = nextTimestamp;
            const frame = (deps.createFrame ?? ((bytes, init) => new VideoFrame(bytes, init)))(new Uint8Array(buffer, NATIVE_CAPTURE_HEADER_BYTES), {
              format: 'I420', codedWidth: format.width, codedHeight: format.height,
              timestamp: Math.round(nextTimestamp - (deps.timeOrigin ?? performance.timeOrigin) * 1000),
              colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
            });
            pacer!.push(frame);
          } catch (error) { cleanup(error instanceof Error ? error : unavailable(), true); }
        });
      } catch (error) { cleanup(error instanceof Error ? error : unavailable()); }
    };
    const local = (fallbackReason: string, replacement = false) => {
      if (replacement) {
        originalStop?.();
        track = createNativeGenerator(); originalStop = track.stop.bind(track);
      }
      pacer = localNativePacer((track as MediaStreamTrack & { writable: WritableStream<VideoFrame> }).writable.getWriter(), delivery, fallbackReason);
      connect();
    };
    try {
      if (deps.createTrackWriter) {
        const created = deps.createTrackWriter(); track = created.track; originalStop = track.stop.bind(track);
        pacer = localNativePacer(created.writer, delivery, 'Injected track writer'); connect();
        return;
      }
      track = createNativeGenerator(); originalStop = track.stop.bind(track);
      if (typeof Worker === 'undefined' || typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
        local('Worker or isolated shared memory is unavailable'); return;
      }
      let workerPacer: NativeWorkerPacer;
      try {
        const worker = new Worker(new URL('./native-frame-worker.ts', import.meta.url), { type: 'module', name: 'native-frame-pacer' });
        workerPacer = new NativeWorkerPacer(worker,
          (track as MediaStreamTrack & { writable: WritableStream<VideoFrame> }).writable,
          { ...delivery, control: new Int32Array(new SharedArrayBuffer(4)) });
        pacer = workerPacer;
      } catch (error) { local(`Worker startup failed: ${String(error)}`, true); return; }
      void workerPacer.ready.then(() => connect(), error => {
        if (closed) return;
        // A transferred stream cannot be reclaimed. Stop its generator and use
        // a fresh one; no source frame has been received or published yet.
        void workerPacer.close();
        try { local(`Worker initialization failed: ${String(error)}`, true); }
        catch (failure) { cleanup(failure instanceof Error ? failure : unavailable()); }
      });
    } catch (error) { cleanup(error instanceof Error ? error : unavailable()); }
  });
}

export async function captureNativeScreen(connection: NativeCaptureConnection, constraints: DisplayMediaStreamOptions, deps: {
  capture?: (options: DisplayMediaStreamOptions) => Promise<MediaStream>;
  open?: typeof openNativeVideoTrack;
  signal?: AbortSignal;
} = {}): Promise<MediaStream> {
  // The standard picker preserves deliberate screen/audio selection and permission.
  const stream = await abortableCapture(() => (deps.capture ?? (options => navigator.mediaDevices.getDisplayMedia(options)))(constraints),
    deps.signal, stopCaptureStream);
  const video = stream.getVideoTracks()[0];
  const abort = new AbortController();
  const ended = () => abort.abort();
  let sentinelReleased = false;
  const releaseSentinel = () => {
    if (sentinelReleased) return;
    sentinelReleased = true;
    video?.removeEventListener('ended', ended);
    deps.signal?.removeEventListener('abort', ended);
    video?.stop();
  };
  try {
    if (deps.signal?.aborted || video?.readyState === 'ended') throw captureAborted();
    deps.signal?.addEventListener('abort', ended, { once: true });
    const settings = video?.getSettings();
    // Device identifiers can vary by document/browser. Only the legacy known
    // identifier can use an old helper; other monitor selections require the
    // helper's checked single-display capability, never a screen:* wildcard.
    if (settings?.displaySurface !== 'monitor') {
      throw new NativeCaptureError('unsupported-source', 'Native capture requires an entire monitor selected in the browser picker.');
    }
    const requireSourceProof = settings.deviceId !== 'screen:0:0';
    video.addEventListener('ended', ended, { once: true });
    // Keep browser permission and its Stop sharing action alive without running
    // a second high-cadence capture beside DXGI. This track is never published.
    await abortableCapture(() => video.applyConstraints?.({ frameRate: { ideal: 1, max: 1 } }).catch(() => undefined), abort.signal);
    const requested = typeof constraints.video === 'object' ? constraints.video.frameRate : undefined;
    const rate = typeof requested === 'number' ? requested : typeof requested?.ideal === 'number' ? requested.ideal : 30;
    const native = await abortableCapture(() => (deps.open ?? openNativeVideoTrack)(connection, rate >= 60 ? 60 : 30,
      { signal: abort.signal, ...(requireSourceProof ? { sourcePolicy: 'single-active-monitor' } : {}) }),
      abort.signal, track => track.stop());
    if (abort.signal.aborted) { native.stop(); throw new DOMException('Screen selection ended.', 'AbortError'); }
    if (requireSourceProof && !nativeSources.has(native)) {
      native.stop(); throw new NativeCaptureError('unsupported-source', 'Native capture did not verify the selected monitor.');
    }
    const nativeSettings = native.getSettings?.bind(native);
    // Preserve selection provenance for the existing system-audio isolation check.
    // Dimensions remain those of the actual native frames, not the original monitor.
    native.getSettings = () => ({ ...settings, ...nativeSettings?.(), displaySurface: settings.displaySurface, deviceId: settings.deviceId });
    const nativeStop = native.stop.bind(native);
    let nativeStopped = false;
    const nativeEnded = () => { nativeStopped = true; releaseSentinel(); native.removeEventListener('ended', nativeEnded); };
    native.addEventListener('ended', nativeEnded, { once: true });
    native.stop = () => {
      releaseSentinel(); native.removeEventListener('ended', nativeEnded);
      if (nativeStopped) return;
      nativeStopped = true; nativeStop();
    };
    stream.removeTrack(video); stream.addTrack(native);
    return stream;
  } catch (error) {
    abort.abort();
    releaseSentinel();
    for (const track of stream.getTracks()) if (track !== video) track.stop();
    throw error;
  }
}
