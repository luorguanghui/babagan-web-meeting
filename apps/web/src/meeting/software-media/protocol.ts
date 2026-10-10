export const CONTROL_LABEL = 'meeting-screen-control-v1';
export const MEDIA_LABEL = 'meeting-screen-media-v1';
export const HEADER_BYTES = 32;
const MAX_MESSAGE = 12 * 1024;
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_AUDIO_FRAME = 64 * 1024;
export interface EncodedFrame {
  kind: 'video' | 'audio';
  id: number;
  timestampUs: number;
  keyframe: boolean;
  data: Uint8Array;
}
export interface MediaFragment extends EncodedFrame {
  generation: number;
  total: number;
  index: number;
  count: number;
}
function validUint32(value: number): boolean { return Number.isInteger(value) && value >= 0 && value <= 0xffffffff; }
export function fragmentFrame(frame: EncodedFrame, generation: number, maxMessageSize: number): ArrayBuffer[] {
  if (!validUint32(generation) || !validUint32(frame.id) || !Number.isSafeInteger(frame.timestampUs) || frame.timestampUs < 0 ||
    !frame.data.length || frame.data.length > (frame.kind === 'audio' ? MAX_AUDIO_FRAME : MAX_FRAME)) throw new Error('Invalid media frame');
  const size = Math.min(MAX_MESSAGE, maxMessageSize === 0 ? MAX_MESSAGE : maxMessageSize);
  if (!(size > HEADER_BYTES)) throw new Error('SCTP message limit is too small');
  const payloadSize = Math.floor(size) - HEADER_BYTES;
  const count = Math.ceil(frame.data.length / payloadSize);
  if (count > 256) throw new Error('Too many media fragments');
  return Array.from({ length: count }, (_, index) => {
    const data = frame.data.subarray(index * payloadSize, (index + 1) * payloadSize);
    const buffer = new ArrayBuffer(HEADER_BYTES + data.length), view = new DataView(buffer);
    view.setUint16(0, 0x534d, true);
    view.setUint8(2, 1);
    view.setUint8(3, frame.kind === 'video' ? 0 : 1);
    view.setUint32(4, generation, true);
    view.setUint32(8, frame.id, true);
    view.setFloat64(12, frame.timestampUs, true);
    view.setUint32(20, frame.data.length, true);
    view.setUint16(24, index, true);
    view.setUint16(26, count, true);
    view.setUint8(28, frame.keyframe ? 1 : 0);
    new Uint8Array(buffer, HEADER_BYTES).set(data);
    return buffer;
  });
}
export function parseFragment(buffer: ArrayBuffer): MediaFragment {
  if (buffer.byteLength <= HEADER_BYTES || buffer.byteLength > MAX_MESSAGE) throw new Error('Invalid media message length');
  const view = new DataView(buffer), kindByte = view.getUint8(3);
  const timestampUs = view.getFloat64(12, true), total = view.getUint32(20, true), count = view.getUint16(26, true);
  const index = view.getUint16(24, true), flags = view.getUint8(28);
  if (view.getUint16(0, true) !== 0x534d || view.getUint8(2) !== 1 || kindByte > 1 || flags > 1 ||
    view.getUint8(29) || view.getUint8(30) || view.getUint8(31) || !Number.isSafeInteger(timestampUs) || timestampUs < 0 ||
    !total || total > (kindByte === 1 ? MAX_AUDIO_FRAME : MAX_FRAME) || !count || count > 256 || index >= count ||
    buffer.byteLength - HEADER_BYTES > total || total < count || total > count * (MAX_MESSAGE - HEADER_BYTES)) throw new Error('Invalid media fragment');
  return { kind: kindByte === 0 ? 'video' : 'audio', id: view.getUint32(8, true), generation: view.getUint32(4, true),
    timestampUs, keyframe: flags === 1, total, index, count, data: new Uint8Array(buffer, HEADER_BYTES) };
}
interface Assembly { first: MediaFragment; started: number; parts: Map<number, Uint8Array>; bytes: number; }
export class FrameAssembler {
  private readonly frames = new Map<string, Assembly>();
  private readonly delivered = new Set<string>();
  pendingBytes = 0;
  droppedFrames = 0;
  lostVideoFrames = 0;
  constructor(private readonly generation: number) {}
  get pendingFrames(): number { return this.frames.size; }
  expire(now: number): void {
    for (const [key, frame] of this.frames) if (now - frame.started > 150) this.remove(key, true);
  }
  clear(): void { this.frames.clear(); this.delivered.clear(); this.pendingBytes = 0; }
  private remove(key: string, dropped: boolean): void {
    const frame = this.frames.get(key);
    if (!frame) return;
    this.pendingBytes -= frame.first.total;
    this.frames.delete(key);
    if (dropped) { this.droppedFrames++; if (frame.first.kind === 'video') this.lostVideoFrames++; }
  }
  push(buffer: ArrayBuffer, now: number): EncodedFrame | null {
    this.expire(now);
    const fragment = parseFragment(buffer);
    if (fragment.generation !== this.generation) return null;
    const key = `${fragment.kind}:${fragment.id}`;
    if (this.delivered.has(key)) return null;
    let frame = this.frames.get(key);
    if (!frame) {
      while (this.frames.size >= 8 || this.pendingBytes + fragment.total > 8 * 1024 * 1024) {
        const oldest = this.frames.keys().next().value;
        if (oldest === undefined) return null;
        this.remove(oldest, true);
      }
      frame = { first: fragment, started: now, parts: new Map(), bytes: 0 };
      this.frames.set(key, frame);
      this.pendingBytes += fragment.total;
    }
    const first = frame.first;
    if (first.total !== fragment.total || first.count !== fragment.count || first.timestampUs !== fragment.timestampUs || first.keyframe !== fragment.keyframe) {
      this.remove(key, true); throw new Error('Conflicting media metadata');
    }
    const previous = frame.parts.get(fragment.index);
    if (previous) {
      if (previous.length !== fragment.data.length || previous.some((byte, index) => byte !== fragment.data[index])) {
        this.remove(key, true); throw new Error('Conflicting duplicate fragment');
      }
      return null;
    }
    frame.parts.set(fragment.index, fragment.data);
    frame.bytes += fragment.data.length;
    if (frame.bytes > fragment.total) { this.remove(key, true); throw new Error('Media assembly overflow'); }
    if (frame.parts.size !== fragment.count) return null;
    if (frame.bytes !== fragment.total) { this.remove(key, true); throw new Error('Incomplete media length'); }
    const data = new Uint8Array(fragment.total);
    let offset = 0;
    for (let index = 0; index < fragment.count; index++) {
      const part = frame.parts.get(index)!;
      data.set(part, offset); offset += part.length;
    }
    this.remove(key, false);
    this.delivered.add(key);
    if (this.delivered.size > 64) this.delivered.delete(this.delivered.values().next().value!);
    return { kind: first.kind, id: first.id, timestampUs: first.timestampUs, keyframe: first.keyframe, data };
  }
}
export function softwareBudget(selected: number, viewers: number): { videoBps: number; wireBps: number } {
  if (!Number.isSafeInteger(selected) || selected < 100000 || selected > 40000000 || !Number.isSafeInteger(viewers) || viewers < 1 || viewers > 4) {
    throw new Error('Invalid software uplink budget');
  }
  const wireBps = Math.min(selected, Math.floor(40000000 / viewers));
  const videoBps = Math.floor(wireBps / 1.12 - 128000);
  if (videoBps < 100000) throw new Error('Insufficient wire budget for video and shared audio');
  return { wireBps, videoBps };
}
