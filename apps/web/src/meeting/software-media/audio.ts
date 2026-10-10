import { PlaybackClock } from './playback-clock.js';
export class ProjectAudioCapture {
  private worker?: Worker;
  private context?: AudioContext;
  private track?: MediaStreamTrack;
  private node?: AudioWorkletNode;
  private pending = 0;
  private closed = false;
  private stopResolve?: () => void;
  constructor(private readonly onPacket: (data: ArrayBuffer, timestampUs: number) => void, private readonly onError: (message: string) => void) {}
  async start(original: MediaStreamTrack): Promise<void> {
    this.track = original.clone();
    const worker = new Worker(new URL('./audio-worker.ts', import.meta.url), { type: 'module', name: 'project-share-opus' });
    this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Project Opus initialization timed out')), 15000);
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); this.onError(event.message); };
      worker.onmessage = ({ data }: MessageEvent<{ type: string; data?: ArrayBuffer; timestampUs?: number; message?: string }>) => {
        if (data.type === 'stopped') { this.stopResolve?.(); return; }
        if (this.closed) return;
        if (data.type === 'ready') { clearTimeout(timeout); resolve(); }
        else if (data.type === 'error') { clearTimeout(timeout); reject(new Error(data.message)); this.onError(data.message ?? 'Opus failed'); }
        else if (data.type === 'ack') this.pending = Math.max(0, this.pending - 1);
        else if (data.type === 'audio' && data.data && data.timestampUs !== undefined) this.onPacket(data.data, data.timestampUs);
      };
      worker.postMessage({ type: 'init' });
    });
    if (this.closed) return;
    const context = new AudioContext({ sampleRate: 48000 }); this.context = context;
    await context.audioWorklet.addModule(new URL('./audio-capture.worklet.js', import.meta.url));
    if (this.closed) { await context.close(); return; }
    await context.resume();
    const anchor = performance.timeOrigin + performance.now() - context.currentTime * 1000;
    this.node = new AudioWorkletNode(context, 'project-share-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.onmessage = ({ data }: MessageEvent<{ data: Float32Array<ArrayBuffer>; contextTime: number }>) => {
      if (this.closed || this.pending >= 8) return;
      this.pending++;
      worker.postMessage({ type: 'pcm', data: data.data, timestampUs: Math.round((anchor + data.contextTime * 1000) * 1000) }, [data.data.buffer]);
    };
    const input = context.createMediaStreamSource(new MediaStream([this.track]));
    const silent = context.createGain(); silent.gain.value = 0;
    input.connect(this.node); this.node.connect(silent); silent.connect(context.destination);
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    this.track?.stop(); this.node?.disconnect();
    if (this.context && this.context.state !== 'closed') await this.context.close();
    if (this.worker) {
      const worker = this.worker;
      await new Promise<void>(resolve => { const timeout = setTimeout(resolve, 1000); this.stopResolve = () => { clearTimeout(timeout); resolve(); }; worker.postMessage({ type: 'stop' }); });
      worker.terminate(); this.worker = undefined;
    }
  }
}
export class ProjectAudioPlayback {
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private decoder?: AudioDecoder;
  private anchor = 0;
  private closed = false;
  track?: MediaStreamTrack;
  constructor(private readonly clock: PlaybackClock, private readonly onError: (message: string) => void) {}
  async initialize(): Promise<void> {
    const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
    if (typeof AudioDecoder === 'undefined' || !(await AudioDecoder.isConfigSupported(config)).supported) throw new Error('Shared Opus decoding unavailable');
    const context = new AudioContext({ sampleRate: 48000 }); this.context = context;
    await context.audioWorklet.addModule(new URL('./audio-playback.worklet.js', import.meta.url));
    if (this.closed) { await context.close(); return; }
    this.node = new AudioWorkletNode(context, 'project-share-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const destination = context.createMediaStreamDestination(); this.node.connect(destination);
    this.track = destination.stream.getAudioTracks()[0];
    this.anchor = performance.timeOrigin + performance.now() - context.currentTime * 1000;
    void this.resume().catch(() => undefined);
    this.decoder = new AudioDecoder({ output: data => {
      try {
        if (this.closed || !this.context || !this.node || data.numberOfFrames > 5760 || data.numberOfChannels !== 2) return;
        const now = performance.now(); this.clock.anchor(data.timestamp, now);
        const due = this.clock.dueAt(data.timestamp);
        if (now - due > 200) return;
        const samples = new Float32Array(data.numberOfFrames * 2);
        data.copyTo(samples, { planeIndex: 0, format: 'f32' });
        const startFrame = Math.round((due + performance.timeOrigin - this.anchor) * 48);
        this.node.port.postMessage({ samples, startFrame }, [samples.buffer]);
      } finally { data.close(); }
    }, error: error => this.onError(String(error)) });
    this.decoder.configure(config);
  }
  async resume(): Promise<void> {
    if (!this.context || this.closed) return;
    await this.context.resume();
    this.anchor = performance.timeOrigin + performance.now() - this.context.currentTime * 1000;
  }
  packet(data: Uint8Array, timestampUs: number): void {
    if (this.closed || !this.decoder || this.decoder.state !== 'configured' || this.decoder.decodeQueueSize >= 8) return;
    this.decoder.decode(new EncodedAudioChunk({ type: 'key', data, timestamp: timestampUs, duration: 20000 }));
  }
  clear(): void { this.node?.port.postMessage({ type: 'clear' }); }
  get blocked(): boolean { return this.context?.state === 'suspended'; }
  async close(): Promise<void> {
    this.closed = true; this.track?.stop(); this.node?.disconnect();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }
}
