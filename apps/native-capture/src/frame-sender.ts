import { NATIVE_CAPTURE_HEADER_BYTES, NATIVE_CAPTURE_PACKET_MAGIC, type NativeCaptureCounters } from '@meeting/contracts';
import type { TimedFrame } from './timestamps.js';
export interface FrameTransport {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Buffer, options: { binary: true; fin: boolean }, callback?: (error?: Error) => void): void;
}
export class FrameSender {
  private capturedFrames = 0;
  private sentFrames = 0;
  private droppedFrames = 0;
  private contentChangedFrames = 0;
  private pendingFrames = 0;
  private previousFrame: Buffer | undefined;
  constructor(private readonly transport: FrameTransport) {}

  send({ frame, index, captureUs }: TimedFrame): void {
    this.capturedFrames++;
    // Count content transitions separately from actual capture samples, including candidates dropped by transport.
    if (!this.previousFrame?.equals(frame)) this.contentChangedFrames++;
    this.previousFrame = frame;
    const packetBytes = NATIVE_CAPTURE_HEADER_BYTES + frame.length;
    if (this.transport.readyState !== 1 || this.pendingFrames >= 2 || this.transport.bufferedAmount > packetBytes * 2) {
      this.droppedFrames++;
      return;
    }
    const header = Buffer.allocUnsafe(NATIVE_CAPTURE_HEADER_BYTES);
    header.writeUInt32BE(NATIVE_CAPTURE_PACKET_MAGIC, 0);
    header.writeUInt32BE(index >>> 0, 4);
    header.writeDoubleBE(captureUs, 8);
    let completed = false;
    this.pendingFrames++;
    const complete = (failed: boolean) => {
      if (completed) return;
      completed = true;
      this.pendingFrames--;
      if (failed) this.droppedFrames++;
      else this.sentFrames++;
    };
    try {
      // The transport groups header and pixels into one packet without copying the full I420 frame again.
      this.transport.send(header, { binary: true, fin: false });
      this.transport.send(frame, { binary: true, fin: true }, (error) => complete(Boolean(error)));
    } catch {
      complete(true);
    }
  }

  stats(): NativeCaptureCounters {
    return { type: 'stats', capturedFrames: this.capturedFrames, sentFrames: this.sentFrames,
      droppedFrames: this.droppedFrames, contentChangedFrames: this.contentChangedFrames };
  }
}
