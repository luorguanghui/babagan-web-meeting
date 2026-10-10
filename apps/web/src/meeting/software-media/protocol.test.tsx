import { describe, expect, it } from 'vitest';
import { fragmentFrame, parseFragment, FrameAssembler, softwareBudget } from './protocol.js';

const frame = { kind: 'video' as const, id: 4, timestampUs: 123456, keyframe: true, data: new Uint8Array(40000).fill(81) };
describe('project media boundary', () => {
  it('reassembles real payload across reversed fragments and ignores duplicates', () => {
    const fragments = fragmentFrame(frame, 7, 8192);
    expect(fragments.every(fragment => fragment.byteLength <= 8192)).toBe(true);
    const receiver = new FrameAssembler(7);
    expect(receiver.push(fragments[2], 0)).toBeNull();
    expect(receiver.push(fragments[2], 0)).toBeNull();
    let result;
    for (const fragment of fragments.toReversed()) result = receiver.push(fragment, 10) ?? result;
    expect(result?.data).toEqual(frame.data);
    expect(result?.timestampUs).toBe(123456);
    expect(receiver.push(fragments[0], 20)).toBeNull();
    expect(receiver.pendingBytes).toBe(0);
  });
  it('rejects malformed bounds, reserved flags and impossibly small SCTP messages', () => {
    const [data] = fragmentFrame(frame, 7, 12288);
    const broken = data.slice(0);
    new DataView(broken).setUint32(20, 3 * 1024 * 1024, true);
    expect(() => parseFragment(broken)).toThrow();
    new DataView(broken).setUint32(20, 40000, true);
    new DataView(broken).setUint8(28, 255);
    expect(() => parseFragment(broken)).toThrow();
    expect(() => fragmentFrame(frame, 7, 32)).toThrow();
    expect(() => fragmentFrame({ ...frame, data: new Uint8Array(2 * 1024 * 1024 + 1) }, 7, 12288)).toThrow();
  });
  it('discards stale generations and expires incomplete data within 150 ms', () => {
    const receiver = new FrameAssembler(7);
    expect(receiver.push(fragmentFrame(frame, 6, 12288)[0], 0)).toBeNull();
    expect(receiver.pendingBytes).toBe(0);
    receiver.push(fragmentFrame(frame, 7, 12288)[0], 0);
    receiver.expire(151);
    expect(receiver.pendingBytes).toBe(0);
    expect(receiver.droppedFrames).toBe(1);
  });
  it('bounds concurrent advertised allocations at eight frames and eight MiB', () => {
    const receiver = new FrameAssembler(7);
    for (let id = 0; id < 20; id++) {
      receiver.push(fragmentFrame({ ...frame, id, data: new Uint8Array(2 * 1024 * 1024) }, 7, 12288)[0], id);
      expect(receiver.pendingBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(receiver.pendingFrames).toBeLessThanOrEqual(8);
    }
    expect(receiver.droppedFrames).toBeGreaterThan(0);
  });
  it('rejects conflicting duplicate bytes instead of decoding a damaged frame', () => {
    const receiver = new FrameAssembler(7);
    const [data] = fragmentFrame(frame, 7, 12288);
    receiver.push(data, 0);
    const changed = data.slice(0);
    new Uint8Array(changed)[40] ^= 1;
    expect(() => receiver.push(changed, 1)).toThrow();
    expect(receiver.pendingBytes).toBe(0);
  });
  it('reserves audio and wire overhead and keeps four independent budgets below 40Mbps', () => {
    for (const selected of [5000000, 8000000, 10000000]) {
      const budget = softwareBudget(selected, 4);
      expect((budget.videoBps + 128000) * 1.12).toBeLessThanOrEqual(budget.wireBps);
      expect(budget.wireBps * 4).toBeLessThanOrEqual(40000000);
      expect(budget.videoBps).toBeLessThan(selected);
    }
  });
});
