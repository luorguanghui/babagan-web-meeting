import { describe, expect, it } from 'vitest';
import { FrameSender, type FrameTransport } from './frame-sender.js';

describe('bounded native packet transport', () => {
  it('drops stale frames under backpressure and resumes with the original sequence and timestamp', () => {
    const chunks: Buffer[] = [];
    const transport: FrameTransport = {
      readyState: 1, bufferedAmount: 57,
      send(data, _options, callback) { chunks.push(data); callback?.(); }
    };
    const sender = new FrameSender(transport);
    sender.send({ frame: Buffer.from('abcdefghijkl'), index: 0, captureUs: 1_700_000_000_000_000 });
    Object.assign(transport, { bufferedAmount: 0 });
    sender.send({ frame: Buffer.from('mnopqrstuvwx'), index: 1, captureUs: 1_700_000_000_016_667 });
    const packet = Buffer.concat(chunks);
    expect(packet.length).toBe(28);
    expect(packet.readUInt32BE(0)).toBe(0x424e4331);
    expect(packet.readUInt32BE(4)).toBe(1);
    expect(packet.readDoubleBE(8)).toBe(1_700_000_000_016_667);
    expect(packet.subarray(16).toString()).toBe('mnopqrstuvwx');
    expect(sender.stats()).toEqual({ type: 'stats', capturedFrames: 2, sentFrames: 1, droppedFrames: 1, contentChangedFrames: 2 });
  });

  it('accounts for disconnected and failed writes without reporting them as delivered frames', () => {
    const transport: FrameTransport = { readyState: 3, bufferedAmount: 0, send(_data, options, callback) { if (options.fin) callback?.(new Error('closed')); } };
    const sender = new FrameSender(transport);
    sender.send({ frame: Buffer.alloc(12), index: 0, captureUs: 1 });
    Object.assign(transport, { readyState: 1 });
    sender.send({ frame: Buffer.alloc(12), index: 1, captureUs: 2 });
    expect(sender.stats()).toEqual({ type: 'stats', capturedFrames: 2, sentFrames: 0, droppedFrames: 2, contentChangedFrames: 1 });
  });

  it('sends every selected captured sample during static periods while counting its content change only once', () => {
    const packets: Buffer[] = [];
    const transport: FrameTransport = { readyState: 1, bufferedAmount: 0, send(data, options, callback) { if (options.fin) packets.push(data); callback?.(); } };
    const sender = new FrameSender(transport);
    for (const [index, captureUs] of [[0, 1_000_000], [1, 1_016_667], [2, 1_033_334], [3, 1_050_001]]) {
      sender.send({ frame: Buffer.alloc(12, 10), index, captureUs });
    }
    expect(packets).toHaveLength(4);
    expect(sender.stats()).toEqual({ type: 'stats', capturedFrames: 4, sentFrames: 4, droppedFrames: 0, contentChangedFrames: 1 });
  });

  it('counts actual pixel transitions independently of transport drops and includes changes at the last pixel', () => {
    const transport: FrameTransport = { readyState: 1, bufferedAmount: 0, send(_data, _options, callback) { callback?.(); } };
    const sender = new FrameSender(transport);
    const original = Buffer.alloc(12, 10);
    const changed = Buffer.from(original); changed[11] = 11;
    sender.send({ frame: original, index: 0, captureUs: 0 });
    Object.assign(transport, { bufferedAmount: 57 });
    sender.send({ frame: changed, index: 1, captureUs: 16_667 });
    Object.assign(transport, { bufferedAmount: 0 });
    sender.send({ frame: Buffer.from(changed), index: 2, captureUs: 33_334 });
    sender.send({ frame: Buffer.from(original), index: 3, captureUs: 50_001 });
    expect(sender.stats()).toEqual({ type: 'stats', capturedFrames: 4, sentFrames: 3, droppedFrames: 1, contentChangedFrames: 3 });
  });

  it('allows two in-flight frames including transport framing bytes and drops the third until a write completes', () => {
    let bufferedAmount = 0;
    let header = Buffer.alloc(0);
    const packets: Buffer[] = [];
    const completions: Array<(error?: Error) => void> = [];
    const transport: FrameTransport = { readyState: 1, get bufferedAmount() { return bufferedAmount; },
      send(data, options, callback) {
        if (!options.fin) { header = data; return; }
        packets.push(Buffer.concat([header, data]));
        bufferedAmount += header.length + data.length + 2;
        completions.push(callback!);
      }
    };
    const sender = new FrameSender(transport);
    for (let index = 0; index < 3; index++) sender.send({ frame: Buffer.alloc(12, index), index, captureUs: index * 16_667 });
    expect(packets.map((packet) => packet.readUInt32BE(4))).toEqual([0, 1]);
    expect(sender.stats()).toEqual({ type: 'stats', capturedFrames: 3, sentFrames: 0, droppedFrames: 1, contentChangedFrames: 3 });
    bufferedAmount -= 30; completions.shift()!();
    sender.send({ frame: Buffer.alloc(12, 3), index: 3, captureUs: 50_001 });
    expect(packets.map((packet) => packet.readUInt32BE(4))).toEqual([0, 1, 3]);
    for (const complete of completions) complete();
    expect(sender.stats()).toEqual({ type: 'stats', capturedFrames: 4, sentFrames: 3, droppedFrames: 1, contentChangedFrames: 4 });
  });
});
