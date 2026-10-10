export interface ProjectStats {
  audioBlocked?: boolean;
  rawFps?: number; encodedFps?: number; decodedFps?: number; renderedFps?: number; encodedBps?: number; sentBps?: number;
  codec: 'h264' | 'vp8'; width: number; height: number; rawFrames: number; encodedFrames: number;
  encodedBytes: number; queueDrops: number; expiredDrops: number; encodeMs: number; filter: number;
  sentBytes: number; receivedBytes: number; decodedFrames: number; renderedFrames: number; droppedFrames: number;
  videoBps: number; wireBps: number;
}
export function emptyStats(codec: 'h264' | 'vp8' = 'h264'): ProjectStats {
  return { codec, width: 0, height: 0, rawFrames: 0, encodedFrames: 0, encodedBytes: 0, queueDrops: 0, expiredDrops: 0,
    encodeMs: 0, filter: 1, sentBytes: 0, receivedBytes: 0, decodedFrames: 0, renderedFrames: 0, droppedFrames: 0, videoBps: 0, wireBps: 0 };
}
export interface VideoPacket {
  type: 'video'; data: ArrayBuffer; timestampUs: number; keyframe: boolean; codec: string; width: number; height: number; revision: number;
  stats: { encodedFrames: number; encodedBytes: number; encodeMs: number; filter: number; expiredDrops: number; queueDrops: number; skipped: number };
}
interface ProcessorConstructor { new(options: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<VideoFrame> }; }
export class ProjectCaptureEncoder {
  private worker?: Worker;
  private reader?: ReadableStreamDefaultReader<VideoFrame>;
  private track?: MediaStreamTrack;
  private closed = false;
  private pending = 0;
  private captureDrops = 0;
  private processingExpired = 0;
  private baseTimestamp?: number;
  private lastSubmitted = -Infinity;
  private stopResolve?: () => void;
  readonly stats: ProjectStats;
  constructor(private readonly options: { codec: 'h264' | 'vp8'; frameRate: number; bitrate: number; threads: number },
    private readonly onPacket: (packet: VideoPacket) => void, private readonly onError: (message: string) => void) {
    this.stats = emptyStats(options.codec);
  }
  async start(original: MediaStreamTrack): Promise<void> {
    const Processor = (globalThis as unknown as { MediaStreamTrackProcessor?: ProcessorConstructor }).MediaStreamTrackProcessor;
    if (!Processor) throw new Error('Raw screen frames unavailable; select browser compatibility encoding');
    this.track = original.clone();
    this.reader = new Processor({ track: this.track, maxBufferSize: 1 }).readable.getReader();
    const worker = new Worker(new URL('./encoder-worker.ts', import.meta.url), { type: 'module', name: 'project-screen-encoder' });
    this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Project encoder initialization timed out')), 15000);
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); this.onError(event.message); };
      worker.onmessage = ({ data }: MessageEvent<VideoPacket | { type: string; count?: number; expired?: boolean; message?: string }>) => {
        if (data.type === 'stopped') { this.stopResolve?.(); return; }
        if (this.closed) return;
        if (data.type === 'ready') { clearTimeout(timeout); resolve(); }
        else if (data.type === 'error') { clearTimeout(timeout); reject(new Error('message' in data ? data.message : 'Project codec failed')); this.onError('message' in data ? data.message ?? 'Project codec failed' : 'Project codec failed'); }
        else if (data.type === 'ack') { this.pending = Math.max(0, this.pending - (('count' in data && data.count) || 1)); }
        else if (data.type === 'expired') { this.processingExpired++; this.stats.expiredDrops++; }
        else if (data.type === 'video') {
          const packet = data as VideoPacket;
          Object.assign(this.stats, packet.stats, { width: packet.width, height: packet.height });
          this.stats.queueDrops = this.captureDrops + packet.stats.queueDrops;
          this.stats.expiredDrops = this.processingExpired + packet.stats.expiredDrops;
          this.onPacket(packet);
        }
      };
      const settings = original.getSettings();
      worker.postMessage({ type: 'init', options: { codec: this.options.codec, width: settings.width ?? 1920, height: settings.height ?? 1080,
        fps: this.options.frameRate, bitrate: this.options.bitrate, threads: this.options.threads } });
    });
    if (this.closed) return;
    void this.capture().catch(error => { if (!this.closed) this.onError(String(error)); });
  }
  private async capture(): Promise<void> {
    while (!this.closed && this.reader) {
      const { value: frame, done } = await this.reader.read();
      if (done || !frame) break;
      if (this.closed) { frame.close(); break; }
      this.stats.rawFrames++;
      const now = performance.timeOrigin + performance.now();
      this.baseTimestamp ??= Math.round(now * 1000) - frame.timestamp;
      const timestampUs = this.baseTimestamp + frame.timestamp;
      if (this.pending >= 2 || timestampUs - this.lastSubmitted < 1000000 / this.options.frameRate - 500) {
        frame.close(); this.captureDrops++; this.stats.queueDrops++; continue;
      }
      this.lastSubmitted = timestampUs; this.pending++;
      this.worker?.postMessage({ type: 'frame', frame, timestampUs, capturedAt: now }, [frame]);
    }
  }
  requestKeyframe(): void { this.worker?.postMessage({ type: 'keyframe' }); }
  setBitrate(bitrate: number): void { this.options.bitrate = bitrate; this.worker?.postMessage({ type: 'bitrate', bitrate }); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.track?.stop();
    void this.reader?.cancel().catch(() => undefined);
    if (this.worker) {
      const worker = this.worker;
      await new Promise<void>(resolve => { const timeout = setTimeout(resolve, 1000); this.stopResolve = () => { clearTimeout(timeout); resolve(); }; worker.postMessage({ type: 'stop' }); });
      worker.terminate(); this.worker = undefined;
    }
  }
}
