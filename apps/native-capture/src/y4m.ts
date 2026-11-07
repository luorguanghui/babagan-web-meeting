import { NATIVE_CAPTURE_MAX_PIXELS } from '@meeting/contracts';

export interface Y4mCallbacks {
  onFormat(format: { width: number; height: number }): void;
  onFrame(frame: Buffer, index: number): void;
}

export class Y4mParser {
  private readonly line = Buffer.allocUnsafe(4096);
  private lineLength = 0;
  private frame: Buffer | undefined;
  private frameOffset = 0;
  private frameBytes = 0;
  private frameIndex = 0;
  private hasHeader = false;

  constructor(private readonly callbacks: Y4mCallbacks) {}

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.frame) {
        const count = Math.min(chunk.length - offset, this.frameBytes - this.frameOffset);
        chunk.copy(this.frame, this.frameOffset, offset, offset + count);
        offset += count;
        this.frameOffset += count;
        if (this.frameOffset === this.frameBytes) {
          const frame = this.frame;
          this.frame = undefined;
          this.frameOffset = 0;
          this.callbacks.onFrame(frame, this.frameIndex++);
        }
        continue;
      }
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const count = end - offset;
      if (this.lineLength + count > this.line.length) throw new Error('Y4M header exceeds limit');
      chunk.copy(this.line, this.lineLength, offset, end);
      this.lineLength += count;
      offset = end;
      if (newline < 0) break;
      offset++;
      const line = this.line.toString('ascii', 0, this.lineLength);
      this.lineLength = 0;
      if (!this.hasHeader) this.readHeader(line);
      else {
        if (line !== 'FRAME') throw new Error('Invalid Y4M frame header');
        this.frame = Buffer.allocUnsafe(this.frameBytes);
      }
    }
  }

  finish(): void {
    if (!this.hasHeader || this.lineLength || this.frame) throw new Error('Truncated Y4M stream');
  }

  private readHeader(line: string): void {
    const parts = line.split(' ');
    if (parts.shift() !== 'YUV4MPEG2') throw new Error('Invalid Y4M signature');
    const fields = new Map<string, string>();
    for (const part of parts) {
      const key = part.startsWith('X') ? part.split('=')[0] : part[0];
      if (!key || fields.has(key)) throw new Error('Invalid or duplicate Y4M field');
      fields.set(key, part.slice(1));
    }
    const width = Number(fields.get('W'));
    const height = Number(fields.get('H'));
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2
      || width % 2 || height % 2 || width * height > NATIVE_CAPTURE_MAX_PIXELS) {
      throw new Error('Unsupported Y4M dimensions');
    }
    if (fields.get('I') !== 'p' || !['420', '420jpeg', '420mpeg2', '420paldv'].includes(fields.get('C') ?? '')
      || (fields.has('XCOLORRANGE') && fields.get('XCOLORRANGE') !== 'COLORRANGE=LIMITED')) {
      throw new Error('Y4M must contain progressive 8-bit limited-range I420');
    }
    this.frameBytes = width * height * 3 / 2;
    this.hasHeader = true;
    this.callbacks.onFormat({ width, height });
  }
}
