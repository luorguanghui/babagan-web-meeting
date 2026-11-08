import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCaptureArguments } from './capture.js';

const ffmpeg = process.env.BABAGAN_TEST_FFMPEG;
const frameBytes = 32 * 16 * 3;
const md5 = (frame: Buffer) => createHash('md5').update(frame).digest('hex');

async function selectedSamples(rate: 30 | 60, ticks: number[], timestampExpression: string) {
  const input = ticks.map((_tick, n) => {
    const frame = Buffer.alloc(frameBytes);
    for (let i = 0; i < frame.length; i++) frame[i] = (i * 43 + n * 17) & 255;
    frame.writeUInt32LE(n, 0);
    return frame;
  });
  const capture = buildCaptureArguments(rate);
  const selection = capture[capture.indexOf('-vf') + 1].match(/select='[^']+'/)?.[0];
  if (!selection) throw new Error('Production capture must select actual frames');
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24',
    '-video_size', '32x16', '-framerate', '60', '-i', 'pipe:0', '-vf',
    `settb=1/720,setpts='${timestampExpression}',${selection}`, '-an', '-fps_mode', 'passthrough',
    '-enc_time_base', '1:720', '-pix_fmt', 'rgb24', '-f', 'framemd5', 'pipe:1'];
  const child = spawn(ffmpeg!, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => output += chunk.toString());
  child.stderr.on('data', chunk => errors = (errors + chunk.toString()).slice(-8192));
  const completed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(errors)));
    child.stdin.once('error', reject);
  });
  child.stdin.end(Buffer.concat(input));
  await completed;
  const rows = output.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
    const columns = line.split(',').map(column => column.trim());
    return { pts: Number(columns[2]), hash: columns[5] };
  });
  const original = new Map(ticks.map((pts, n) => [pts, md5(input[n])]));
  expect(original.size).toBe(input.length);
  // Every emitted sample must be an unmodified original image at its original
  // PTS, and no input can be emitted twice to manufacture a target frame rate.
  expect(new Set(rows.map(row => row.pts)).size).toBe(rows.length);
  for (const row of rows) expect(row.hash).toBe(original.get(row.pts));
  return rows;
}

describe.skipIf(!ffmpeg)('real FFmpeg capture cadence (opt in with BABAGAN_TEST_FFMPEG)', () => {
  it.each([30, 60] as const)('retains every distinct %sfps sample across all five 144Hz timestamp phases', async rate => {
    for (const phase of [0, 1, 2, 3, 4]) {
      const ticks = Array.from({ length: rate * 10 }, (_, n) => Math.ceil((n + phase) * (720 / rate) / 5) * 5);
      const output = await selectedSamples(rate, ticks, `ceil((N+${phase})*${720 / rate}/5)*5`);
      expect(output.map(row => row.pts)).toEqual(ticks);
    }
  });

  it.each([30, 60] as const)('limits a double-rate source to %sfps without duplicated images or changed PTS', async rate => {
    const ticks = Array.from({ length: rate * 20 }, (_, n) => n * 360 / rate);
    const output = await selectedSamples(rate, ticks, `N*${360 / rate}`);
    expect(output.map(row => row.pts)).toEqual(ticks.filter((_tick, n) => n % 2 === 0));
  });

  it('retains all 30fps source frames when the target is 60fps', async () => {
    const ticks = Array.from({ length: 300 }, (_, n) => n * 24);
    expect((await selectedSamples(60, ticks, 'N*24')).map(row => row.pts)).toEqual(ticks);
  });

  it.each(['slow', 'static'] as const)('does not catch up at 120fps after a %s source interval', async kind => {
    const before = kind === 'slow' ? 150 : 60;
    const ticks = Array.from({ length: before + 600 }, (_, n) => n < before ? n * (kind === 'slow' ? 24 : 12) : 3600 + (n - before) * 6);
    const output = await selectedSamples(60, ticks, `if(lt(N,${before}),N*${kind === 'slow' ? 24 : 12},3600+(N-${before})*6)`);
    expect(output.map(row => row.pts)).toEqual([...ticks.slice(0, before), ...ticks.slice(before).filter((_tick, n) => n % 2 === 0)]);
  });
});
