import { CONTROL_LABEL, MEDIA_LABEL, FrameAssembler, type EncodedFrame } from './protocol.js';
import { parseControl, type ControlMessage } from './control.js';
import { emptyStats, type ProjectStats } from './encoder.js';
import { PlaybackClock } from './playback-clock.js';
import { ProjectAudioPlayback } from './audio.js';
import { StatsSampler } from './stats-sampler.js';
export class ProjectPeerReceiver {
  private control?: RTCDataChannel;
  private media?: RTCDataChannel;
  private assembler?: FrameAssembler;
  private generation = -1;
  private decoder?: VideoDecoder;
  private config?: VideoDecoderConfig;
  private closed = false;
  private waitingKey = true;
  private expectedId?: number;
  private readonly pending = new Map<number, { frame: EncodedFrame; arrived: number }>();
  private readonly display: Array<{ frame: VideoFrame; due: number }> = [];
  private readonly clock = new PlaybackClock();
  private syncAudio = false;
  private canvas?: HTMLCanvasElement;
  private stream?: MediaStream;
  private lastRequest = -Infinity;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly stats = emptyStats();
  private audio?: ProjectAudioPlayback;
  private audioInitialization?: Promise<void>;
  private readonly sampler = new StatsSampler();
  constructor(private readonly deps: { pc: RTCPeerConnection; onStream: (stream: MediaStream) => void; onError: (message: string) => void }) {
    deps.pc.ondatachannel = event => this.acceptChannel(event.channel);
    this.timer = setInterval(() => this.tick(), 10);
  }
  acceptChannel(channel: RTCDataChannel): void {
    if (this.closed) { channel.close(); return; }
    if (channel.label === CONTROL_LABEL && !this.control) {
      this.control = channel;
      channel.onmessage = event => { void this.controlMessage(String(event.data)).catch(error => this.deps.onError(String(error))); };
      const hello = async () => {
        const codecs: Array<'h264' | 'vp8'> = [];
        if (typeof VideoDecoder !== 'undefined') {
          if ((await VideoDecoder.isConfigSupported({ codec: 'avc1.42c02a' })).supported) codecs.push('h264');
          if ((await VideoDecoder.isConfigSupported({ codec: 'vp8' })).supported) codecs.push('vp8');
        }
        if (!this.closed && channel.readyState === 'open') channel.send(JSON.stringify({ type: 'hello', version: 1, codecs, audio: typeof AudioDecoder !== 'undefined' }));
      };
      channel.onopen = () => { void hello().catch(error => this.deps.onError(String(error))); };
      if (channel.readyState === 'open') void hello().catch(error => this.deps.onError(String(error)));
    } else if (channel.label === MEDIA_LABEL && !this.media) {
      this.media = channel; channel.binaryType = 'arraybuffer';
      channel.onmessage = event => {
        if (this.closed || !(event.data instanceof ArrayBuffer) || !this.assembler) return;
        this.stats.receivedBytes += event.data.byteLength;
        try { const frame = this.assembler.push(event.data, performance.now()); if (frame?.kind === 'video') this.video(frame); else if (frame?.kind === 'audio') this.audio?.packet(frame.data, frame.timestampUs); }
        catch { this.requestKey(); }
      };
    } else channel.close();
  }
  private async controlMessage(raw: string): Promise<void> {
    if (this.closed) return;
    const message = parseControl(raw);
    if (message.type === 'error') throw new Error(message.message);
    if (message.type === 'stats' && message.generation === this.generation) {
      Object.assign(this.stats, { rawFrames: message.rawFrames, encodedFrames: message.encodedFrames, encodedBytes: message.encodedBytes,
        queueDrops: message.queueDrops, expiredDrops: message.expiredDrops, encodeMs: message.encodeMs, filter: message.filter });
    }
    if (message.type !== 'config') return;
    this.generation = message.generation;
    this.clearVideo(); this.clock.reset();
    this.syncAudio = message.audio;
    this.assembler?.clear(); this.assembler = new FrameAssembler(message.generation);
    const config = { codec: message.codec, codedWidth: message.width, codedHeight: message.height, optimizeForLatency: true };
    const support = await VideoDecoder.isConfigSupported(config);
    if (this.closed || this.generation !== message.generation) return;
    if (!support.supported) throw new Error('Project codec decoding unsupported; select compatibility/SFU');
    this.config = config; this.makeDecoder();
    if (message.audio) {
      if (!this.audio) { this.audio = new ProjectAudioPlayback(this.clock, this.deps.onError); this.audioInitialization = this.audio.initialize(); }
      await this.audioInitialization;
      if (this.closed || this.generation !== message.generation) return;
      if (this.stream && this.audio.track && !this.stream.getAudioTracks().includes(this.audio.track)) {
        this.stream.addTrack(this.audio.track); this.deps.onStream(this.stream);
      }
    }
    this.audio?.clear();
    this.stats.codec = message.codec === 'vp8' ? 'vp8' : 'h264'; this.stats.width = message.width; this.stats.height = message.height;
    if (this.control?.readyState === 'open') this.control.send(JSON.stringify({ type: 'ready', generation: this.generation }));
  }
  private makeDecoder(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    const generation = this.generation;
    const decoder = new VideoDecoder({ output: frame => {
      if (this.closed || generation !== this.generation || this.decoder !== decoder) { frame.close(); return; }
      if (frame.displayWidth > 3840 || frame.displayHeight > 2160) { frame.close(); this.requestKey(); return; }
      this.stats.decodedFrames++;
      // Without shared audio there is no timeline to synchronize to. Render
      // live decoded video immediately: a fixed initial clock otherwise makes
      // every later frame permanently "late" after delivery delay increases.
      if (!this.syncAudio) { this.present(frame); return; }
      this.clock.anchor(frame.timestamp, performance.now());
      // A 100ms playout buffer already needs more than six frames at 60fps
      // when decoder output runs before the timer. Six caused the oldest
      // frame to be evicted just before it became due, including the first
      // frame of a new viewer. Twelve covers the bounded 200ms video buffer.
      if (this.display.length >= 12) { this.display.shift()!.frame.close(); this.stats.droppedFrames++; }
      this.display.push({ frame, due: this.clock.dueAt(frame.timestamp) });
    }, error: () => { this.waitingKey = true; this.requestKey(); } });
    this.decoder = decoder; decoder.configure(this.config!);
  }
  private video(frame: EncodedFrame): void {
    if (!this.decoder || !this.config) return;
    if (frame.keyframe) {
      if (this.waitingKey || this.decoder.state === 'closed') this.makeDecoder();
      this.pending.clear(); this.waitingKey = false; this.expectedId = frame.id;
    }
    if (this.waitingKey || (this.expectedId !== undefined && frame.id < this.expectedId)) return;
    if (this.pending.size >= 8) { this.requestKey(); return; }
    this.pending.set(frame.id, { frame, arrived: performance.now() });
    while (this.expectedId !== undefined && this.pending.has(this.expectedId)) {
      const current = this.pending.get(this.expectedId)!.frame;
      this.pending.delete(this.expectedId); this.expectedId++;
      if (this.decoder.decodeQueueSize > 6) { this.requestKey(); break; }
      try { this.decoder.decode(new EncodedVideoChunk({ type: current.keyframe ? 'key' : 'delta', timestamp: current.timestampUs, data: current.data })); }
      catch { this.requestKey(); break; }
    }
  }
  private tick(): void {
    if (this.closed) return;
    const now = performance.now();
    if (this.assembler) {
      const lost = this.assembler.lostVideoFrames; this.assembler.expire(now);
      if (this.assembler.lostVideoFrames > lost) this.requestKey();
    }
    if ([...this.pending.values()].some(item => now - item.arrived > 150)) this.requestKey();
    while (this.display.length && this.display[0].due <= now) {
      const { frame, due } = this.display.shift()!;
      if (now - due > 200) { frame.close(); this.stats.droppedFrames++; continue; }
      this.present(frame);
    }
  }
  private present(frame: VideoFrame): void {
    try {
      this.canvas ??= document.createElement('canvas');
      if (this.canvas.width !== frame.displayWidth) this.canvas.width = frame.displayWidth;
      if (this.canvas.height !== frame.displayHeight) this.canvas.height = frame.displayHeight;
      this.canvas.getContext('2d')?.drawImage(frame, 0, 0);
      if (!this.stream) { this.stream = this.canvas.captureStream(0); if (this.syncAudio && this.audio?.track) this.stream.addTrack(this.audio.track); this.deps.onStream(this.stream); }
      (this.stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame();
      this.stats.renderedFrames++;
    } finally { frame.close(); }
  }
  private requestKey(): void {
    this.pending.clear(); this.waitingKey = true; this.expectedId = undefined;
    if (performance.now() - this.lastRequest < 500 || this.control?.readyState !== 'open') return;
    this.lastRequest = performance.now();
    const message: ControlMessage = { type: 'keyframe', generation: this.generation };
    this.control.send(JSON.stringify(message));
  }
  private clearVideo(): void {
    this.pending.clear(); this.waitingKey = true; this.expectedId = undefined;
    for (const item of this.display.splice(0)) item.frame.close();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined;
  }
  getStats(): ProjectStats { return this.sampler.sample({ ...this.stats, audioBlocked: this.audio?.blocked }); }
  resumeAudio(): Promise<void> { return this.audio?.resume() ?? Promise.resolve(); }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer); this.clearVideo(); this.assembler?.clear();
    this.control?.close(); this.media?.close(); this.stream?.getTracks().forEach(track => track.stop());
    await this.audio?.close();
  }
}
