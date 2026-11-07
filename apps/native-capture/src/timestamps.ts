export interface TimedFrame { frame: Buffer; index: number; captureUs: number }
export class FrameClock {
  private readonly frames = new Map<number, Buffer>();
  private readonly timestamps = new Map<number, number>();
  private readonly stderrLine = Buffer.allocUnsafe(16_384);
  private stderrLength = 0;
  private frameIndex = 0;
  private timestampIndex = 0;
  private pairedIndex = 0;
  private previousPts = -Infinity;
  private epochUs: number | undefined;
  private timeBase: number | undefined;

  constructor(private readonly onFrame: (frame: TimedFrame) => void, private readonly now: () => number = Date.now) {}

  pushFrame(frame: Buffer, index: number): void {
    if (index !== this.frameIndex++) throw new Error('Frame synchronization lost');
    this.frames.set(index, frame);
    this.pair();
  }

  pushStderr(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - offset;
      if (this.stderrLength + length > this.stderrLine.length) throw new Error('FFmpeg stderr line exceeds limit');
      chunk.copy(this.stderrLine, this.stderrLength, offset, end);
      this.stderrLength += length;
      offset = end;
      if (newline < 0) break;
      offset++;
      const line = this.stderrLine.toString('utf8', 0, this.stderrLength);
      this.stderrLength = 0;
      const base = /\[Parsed_showinfo_\d+ @ [^\]]+\] config in time_base:\s*(\d+)\/(\d+)/.exec(line);
      if (base) {
        const numerator = Number(base[1]);
        const denominator = Number(base[2]);
        if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 1 || denominator < 1
          || this.timestampIndex) throw new Error('Invalid FFmpeg timestamp time base');
        this.timeBase = numerator / denominator;
        continue;
      }
      const match = /\[Parsed_showinfo_\d+ @ [^\]]+\]\s+n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*([-+\deE.]+)/.exec(line);
      if (!match) continue;
      const index = Number(match[1]);
      const ptsUs = Math.round((this.timeBase === undefined ? Number(match[3]) : Number(match[2]) * this.timeBase) * 1_000_000);
      if (index !== this.timestampIndex++ || !Number.isSafeInteger(ptsUs) || ptsUs <= this.previousPts) {
        throw new Error('Invalid FFmpeg timestamp sequence');
      }
      this.previousPts = ptsUs;
      this.timestamps.set(index, ptsUs);
      this.pair();
    }
  }

  finish(): void {
    if (this.frames.size || this.timestamps.size) throw new Error('Frame synchronization lost at end of stream');
  }

  private pair(): void {
    while (this.frames.has(this.pairedIndex) && this.timestamps.has(this.pairedIndex)) {
      const index = this.pairedIndex++;
      const frame = this.frames.get(index)!;
      const ptsUs = this.timestamps.get(index)!;
      this.frames.delete(index);
      this.timestamps.delete(index);
      this.epochUs ??= Math.round(this.now() * 1000) - ptsUs;
      const captureUs = this.epochUs + ptsUs;
      if (!Number.isSafeInteger(captureUs)) throw new Error('Invalid capture timestamp');
      this.onFrame({ frame, index, captureUs });
    }
    if (this.frames.size > 8 || this.timestamps.size > 8) throw new Error('Frame synchronization queue exceeded limit');
  }
}
