import { fragmentFrame, type EncodedFrame } from './protocol.js';
interface Channel { readyState: RTCDataChannelState; bufferedAmount: number; send(data: ArrayBuffer): void; }
interface Pending { frame: EncodedFrame; created: number; finish: (sent: boolean) => void; }
export class ChannelSender {
  private readonly queue: Pending[] = [];
  private running = false;
  private closed = false;
  private nextSendAt = 0;
  sentBytes = 0;
  droppedFrames = 0;
  constructor(private readonly channel: Channel, private readonly generation: number,
    private readonly maxMessageSize: () => number, private wireBps: number,
    private readonly clock = { now: () => performance.now(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }) {}
  setBitrate(bps: number): void {
    if (!Number.isFinite(bps) || bps <= 0) throw new Error('Invalid channel bitrate');
    this.wireBps = bps;
  }
  close(): void {
    this.closed = true;
    for (const pending of this.queue.splice(0)) pending.finish(false);
  }
  send(frame: EncodedFrame): Promise<boolean> {
    if (this.closed || this.channel.readyState !== 'open') return Promise.resolve(false);
    const queuedKind = this.queue.filter(pending => pending.frame.kind === frame.kind).length;
    if (queuedKind >= (frame.kind === 'audio' ? 8 : 3)) { this.droppedFrames++; return Promise.resolve(false); }
    return new Promise(resolve => {
      this.queue.push({ frame, created: this.clock.now(), finish: resolve });
      if (!this.running) void this.drain();
    });
  }
  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length && !this.closed) {
      const pending = this.queue.shift()!;
      let sent = false;
      try { sent = await this.transmit(pending); } catch { sent = false; }
      if (!sent) this.droppedFrames++;
      pending.finish(sent);
    }
    this.running = false;
  }
  private async transmit(pending: Pending): Promise<boolean> {
    const deadline = pending.created + 150;
    const fragments = fragmentFrame(pending.frame, this.generation, this.maxMessageSize());
    const estimatedMs = fragments.reduce((sum, bytes) => sum + bytes.byteLength, 0) * 1.12 * 8000 / this.wireBps;
    if (Math.max(this.clock.now(), this.nextSendAt) + estimatedMs > deadline) return false;
    for (const fragment of fragments) {
      while (!this.closed && this.channel.readyState === 'open') {
        const now = this.clock.now();
        if (now >= deadline) return false;
        if (now >= this.nextSendAt && this.channel.bufferedAmount + fragment.byteLength <= 256 * 1024) break;
        await this.clock.sleep(Math.min(5, deadline - now, Math.max(1, this.nextSendAt - now)));
      }
      if (this.closed || this.channel.readyState !== 'open') return false;
      this.channel.send(fragment);
      this.sentBytes += fragment.byteLength;
      // Keep the pacing deadline when a timer wakes late, rather than charging
      // its scheduling delay to every fragment. Bound catch-up to one message
      // so an idle/stalled channel cannot accumulate an unlimited burst.
      const creditMs = Math.min(12 * 1024, this.maxMessageSize() || 12 * 1024) * 1.12 * 8000 / this.wireBps;
      this.nextSendAt = Math.max(this.nextSendAt, this.clock.now() - creditMs) + fragment.byteLength * 1.12 * 8000 / this.wireBps;
    }
    return true;
  }
}
