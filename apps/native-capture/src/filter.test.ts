import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildCaptureArguments } from './capture.js';
import { Y4mParser } from './y4m.js';
import { FrameSender } from './frame-sender.js';

const ffmpeg = process.env.BABAGAN_TEST_FFMPEG;
async function filteredFrames(input: Buffer[], rate: 30 | 60 = 60): Promise<Buffer[]> {
  const args = buildCaptureArguments(rate);
  args[args.indexOf('lavfi')] = 'yuv4mpegpipe';
  args[args.indexOf('-i') + 1] = 'pipe:0';
  const vf = args.indexOf('-vf') + 1;
  args[vf] = args[vf].replace('hwdownload,format=bgra,', '');
  const frames: Buffer[] = [];
  const parser = new Y4mParser({ onFormat() {}, onFrame: (frame) => frames.push(frame) });
  const child = spawn(ffmpeg!, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', (chunk) => errors = (errors + chunk.toString()).slice(-16_384));
  child.stdout.on('data', (chunk: Buffer) => parser.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(errors)));
  });
  child.stdin.write(`YUV4MPEG2 W32 H32 F${rate * 2}:1 Ip C420mpeg2\n`);
  for (const frame of input) { child.stdin.write('FRAME\n'); child.stdin.write(frame); }
  child.stdin.end();
  await done;
  parser.finish();
  return frames;
}
function solid(luma: number): Buffer {
  const frame = Buffer.alloc(1536, 128);
  frame.fill(luma, 0, 1024);
  return frame;
}

describe.skipIf(!ffmpeg)('real FFmpeg synthetic filter validation (opt in with BABAGAN_TEST_FFMPEG)', () => {
  it('selects 60 captured samples with 60 unique images from a 120fps source containing paired duplicates', async () => {
    const input = Array.from({ length: 120 }, (_, i) => solid(16 + Math.floor(i / 2) * 2));
    const output = await filteredFrames(input);
    expect(output).toHaveLength(60);
    expect(new Set(output.map((frame) => frame.toString('base64'))).size).toBe(60);
  });
  it('keeps 120 captured samples across two static seconds and reports only one content change', async () => {
    const output = await filteredFrames(Array.from({ length: 240 }, () => solid(16)));
    expect(output).toHaveLength(120);
    const sender = new FrameSender({ readyState: 1, bufferedAmount: 0, send(_data, _options, callback) { callback?.(); } });
    output.forEach((frame, index) => sender.send({ frame, index, captureUs: Math.round(index * 1_000_000 / 60) }));
    expect(sender.stats()).toEqual({ type: 'stats', capturedFrames: 120, sentFrames: 120, droppedFrames: 0, contentChangedFrames: 1 });
  });
  it('preserves target sample cadence through static-to-motion transitions without a catch-up burst', async () => {
    const input = [...Array.from({ length: 240 }, () => solid(16)), ...Array.from({ length: 120 }, (_, i) => solid(18 + Math.floor(i / 2) * 2))];
    const output = await filteredFrames(input);
    expect(output).toHaveLength(180);
    expect(new Set(output.slice(0, 120).map(frame => frame.toString('base64'))).size).toBe(1);
    expect(new Set(output.slice(120).map(frame => frame.toString('base64'))).size).toBe(60);
  });
  it('never manufactures more samples when the finite source supplies just one frame', async () => {
    expect(await filteredFrames([solid(16)])).toHaveLength(1);
  });
  it.each([0, 31, 992, 1023, 1024, 1039, 1264, 1279, 1280, 1295, 1520, 1535])('preserves a captured border change at planar offset %s when it falls on a selected time bin', async (offset) => {
    const changed = solid(16);
    changed[offset] = 200;
    const output = await filteredFrames([solid(16), solid(16), changed, changed]);
    expect(output).toHaveLength(2);
    expect(output[0].equals(output[1])).toBe(false);
  });
});
