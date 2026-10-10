import { CONTROL_LABEL, MEDIA_LABEL, softwareBudget } from './protocol.js';
import { parseControl } from './control.js';
import { ChannelSender } from './channel-sender.js';
import { ProjectCaptureEncoder, type VideoPacket, type ProjectStats } from './encoder.js';
import { ProjectAudioCapture } from './audio.js';
import { StatsSampler } from './stats-sampler.js';
export class ProjectPeerSender {
  private readonly control: RTCDataChannel;
  private readonly media: RTCDataChannel;
  private readonly encoder: ProjectCaptureEncoder;
  private pacer?: ChannelSender;
  private generation = 1;
  private revision = -1;
  private started = false;
  private closed = false;
  private ready = false;
  private waitingKey = true;
  private frameId = 0;
  private lastKeyRequest = -Infinity;
  private timer?: ReturnType<typeof setInterval>;
  private audio?: ProjectAudioCapture;
  private audioId = 0;
  private closing?: Promise<void>;
  private readonly sampler = new StatsSampler();
  constructor(private readonly deps: { pc: RTCPeerConnection; stream: MediaStream; options: { codec: string; frameRate: number; maxBitrate: number }; onError: (message: string) => void }) {
    const codec = deps.options.codec === 'auto' ? 'h264' : deps.options.codec;
    if (codec !== 'h264' && codec !== 'vp8') throw new Error('Project encoding supports H264 and VP8 only');
    this.control = deps.pc.createDataChannel(CONTROL_LABEL, { ordered: true });
    this.media = deps.pc.createDataChannel(MEDIA_LABEL, { ordered: false, maxRetransmits: 0 });
    const budget = softwareBudget(deps.options.maxBitrate, 1);
    this.encoder = new ProjectCaptureEncoder({ codec, frameRate: deps.options.frameRate, bitrate: budget.videoBps,
      threads: Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2))) }, packet => this.packet(packet), deps.onError);
    Object.assign(this.encoder.stats, budget);
    this.control.onmessage = event => {
      try {
        const message = parseControl(String(event.data));
        if (message.type === 'hello') {
          if (!message.codecs.includes(codec)) throw new Error('Viewer cannot decode project codec; refresh or choose compatibility/SFU');
          if (deps.stream.getAudioTracks().length && !message.audio) throw new Error('Viewer cannot decode shared sound; choose compatibility/SFU');
          if (!this.started) { this.started = true; void this.begin().catch(error => deps.onError(String(error))); }
        } else if (message.type === 'ready' && message.generation === this.generation) { this.ready = true; this.requestKey(); }
        else if (message.type === 'keyframe' && message.generation === this.generation) this.requestKey();
        else if (message.type === 'error') deps.onError(message.message);
      } catch (error) { deps.onError(String(error)); }
    };
  }
  private async begin(): Promise<void> {
    const track = this.deps.stream.getVideoTracks()[0];
    if (!track) throw new Error('No shared video track');
    if (this.closed) return;
    await this.encoder.start(track);
    if (this.closed) return;
    const audioTrack = this.deps.stream.getAudioTracks()[0];
    if (audioTrack) {
      this.audio = new ProjectAudioCapture((data, timestampUs) => {
        if (this.ready && !this.closed) void this.pacer?.send({ kind: 'audio', id: this.audioId++, timestampUs, keyframe: true, data: new Uint8Array(data) });
      }, this.deps.onError);
      await this.audio.start(audioTrack);
    }
    this.timer = setInterval(() => {
      const s = this.encoder.stats;
      if (this.control.readyState === 'open' && s.width) this.control.send(JSON.stringify({ type: 'stats', generation: this.generation,
        rawFrames: s.rawFrames, encodedFrames: s.encodedFrames, encodedBytes: s.encodedBytes, queueDrops: s.queueDrops,
        expiredDrops: s.expiredDrops, encodeMs: s.encodeMs, filter: s.filter, width: s.width, height: s.height }));
    }, 1000);
  }
  private packet(packet: VideoPacket): void {
    if (this.closed || this.control.readyState !== 'open' || this.media.readyState !== 'open') return;
    if (packet.revision !== this.revision) {
      this.revision = packet.revision; this.generation++; this.ready = false; this.waitingKey = true;
      this.pacer?.close(); this.pacer = new ChannelSender(this.media, this.generation, () => this.deps.pc.sctp?.maxMessageSize ?? 12288, this.encoder.stats.wireBps);
      this.control.send(JSON.stringify({ type: 'config', generation: this.generation, codec: packet.codec, width: packet.width, height: packet.height, audio: this.deps.stream.getAudioTracks().length > 0 }));
    }
    const id = this.frameId++;
    if (!this.ready || (this.waitingKey && !packet.keyframe)) return;
    if (packet.keyframe) this.waitingKey = false;
    void this.pacer?.send({ kind: 'video', id, timestampUs: packet.timestampUs, keyframe: packet.keyframe, data: new Uint8Array(packet.data) }).then(sent => {
      if (!sent && !this.closed) { this.waitingKey = true; this.encoder.stats.droppedFrames++; this.requestKey(); }
    });
  }
  private requestKey(): void {
    if (performance.now() - this.lastKeyRequest < 500) return;
    this.lastKeyRequest = performance.now(); this.encoder.requestKeyframe();
  }
  setBudget(selected: number, viewers: number): void {
    const budget = softwareBudget(selected, viewers); Object.assign(this.encoder.stats, budget);
    this.encoder.setBitrate(budget.videoBps); this.pacer?.setBitrate(budget.wireBps);
  }
  getStats(): ProjectStats { return this.sampler.sample({ ...this.encoder.stats, sentBytes: this.pacer?.sentBytes ?? 0 }); }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.pacer?.close(); this.control.close(); this.media.close();
    this.closing = Promise.all([this.encoder.close(), this.audio?.close()]).then(() => undefined);
    return this.closing;
  }
}
