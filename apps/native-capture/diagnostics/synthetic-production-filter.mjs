// Synthetic pixels only. The real capture arguments are used after replacing ddagrab with testsrc2.
import { fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { URL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildCaptureArguments } from '../dist/capture.js';
import { createNativeCaptureServer } from '../dist/server.js';
import { FrameSender } from '../dist/frame-sender.js';

const ffmpeg = process.argv[2];
if (!ffmpeg) throw new Error('Supply an FFmpeg executable path. This diagnostic uses only testsrc2.');
const origin = 'http://127.0.0.1:5188';

if (process.argv.includes('--helper')) {
  const capturedFrames = [];
  let senderStats = () => undefined;
  const originalSend = FrameSender.prototype.send;
  FrameSender.prototype.send = function(frame) {
    senderStats = () => this.stats();
    capturedFrames.push({ sequence: frame.index, captureUs: frame.captureUs, hash: createHash('sha256').update(frame.frame).digest('hex') });
    return originalSend.call(this, frame);
  };
  const server = await createNativeCaptureServer({ ffmpeg, origin, getActiveDisplayCount: async () => 1, idleTimeoutMs: 30_000,
    spawnProcess: () => {
      const args = buildCaptureArguments(60);
      args[args.indexOf('-i') + 1] = 'testsrc2=size=1920x1080:rate=120:duration=10';
      args[args.indexOf('-vf') + 1] = args[args.indexOf('-vf') + 1].replace('hwdownload,format=bgra,', '');
      args.splice(args.indexOf('-f'), 0, '-re');
      const start = performance.now();
      const child = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let partial = ''; let produced = 0; let lastPtsTime = 0;
      child.stderr.on('data', (chunk) => {
        partial += chunk.toString();
        const lines = partial.split('\n'); partial = lines.pop();
        for (const line of lines) {
          const match = /\[Parsed_showinfo_\d+ @ [^\]]+\]\s+n:\s*(\d+)\s+pts:\s*\S+\s+pts_time:\s*([-+\deE.]+)/.exec(line);
          if (match) { produced = Number(match[1]) + 1; lastPtsTime = Number(match[2]); }
        }
      });
      child.once('close', (exitCode) => process.send?.({ capture: { produced, lastPtsTime, seconds: (performance.now() - start) / 1000, exitCode } }));
      return child;
    }
  });
  process.send?.({ port: server.port, token: server.token });
  process.on('message', async (message) => {
    if (message === 'stats') { process.send?.({ stats: senderStats(), capturedFrames }); return; }
    await server.close(); process.exit();
  });
} else {
  const helper = fork(fileURLToPath(import.meta.url), [ffmpeg, '--helper'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let capture;
  helper.on('message', (message) => { if (message.capture) capture = message.capture; });
  try {
    const config = await new Promise((resolve, reject) => { helper.once('message', resolve); helper.once('error', reject); });
    const frames = [];
    let format;
    let stage = 'length';
    let target = Buffer.alloc(4); let offset = 0;
    const start = performance.now();
    await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: config.port, path: '/frames-http', method: 'POST',
        headers: { Origin: origin, Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' } }, (response) => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
        response.on('data', (chunk) => {
          let sourceOffset = 0;
          while (sourceOffset < chunk.length) {
            const count = Math.min(target.length - offset, chunk.length - sourceOffset);
            chunk.copy(target, offset, sourceOffset, sourceOffset + count); offset += count; sourceOffset += count;
            if (offset !== target.length) continue;
            offset = 0;
            if (stage === 'length') {
              const length = target.readUInt32BE(0); if (length > 4096) throw new Error('Invalid metadata length');
              target = Buffer.alloc(length); stage = 'format';
            } else if (stage === 'format') {
              format = JSON.parse(target.toString()); target = Buffer.allocUnsafe(16 + format.width * format.height * 3 / 2); stage = 'frame';
            } else {
              if (target.readUInt32BE(0) !== 0x424e4331) throw new Error('Invalid frame magic');
              const captureUs = target.readDoubleBE(8);
              frames.push({ sequence: target.readUInt32BE(4), captureUs, arrivalMs: performance.now() - start,
                latencyMs: (Date.now() * 1000 - captureUs) / 1000, hash: createHash('sha256').update(target.subarray(16)).digest('hex') });
            }
          }
        });
        response.on('end', resolve); response.on('error', reject);
      });
      req.on('error', reject); req.end('{"frameRate":60}');
    });
    const seconds = (performance.now() - start) / 1000;
    const observed = await new Promise((resolve) => { helper.once('message', resolve); helper.send('stats'); });
    const first = frames[0]; const last = frames.at(-1);
    const summary = { format, capture, sender: observed.stats, capturedUnique: new Set(observed.capturedFrames.map((frame) => frame.hash)).size,
      consecutiveCapturedDuplicates: observed.capturedFrames.filter((frame, i, all) => i > 0 && frame.hash === all[i - 1].hash).length,
      received: frames.length, fullFrameUnique: new Set(frames.map((frame) => frame.hash)).size,
      inferredTransportDropped: capture.produced - frames.length, seconds,
      receiveSteadyFps: (frames.length - 1) * 1000 / (last.arrivalMs - first.arrivalMs),
      ptsFps: (frames.length - 1) * 1_000_000 / (last.captureUs - first.captureUs),
      firstLatencyMs: first.latencyMs, lastLatencyMs: last.latencyMs };
    await writeFile(new URL('./synthetic-production-filter-results-20261107.json', import.meta.url), JSON.stringify({ summary, frames, capturedFrames: observed.capturedFrames }, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    if (helper.connected) { helper.send('stop'); await new Promise((resolve) => helper.once('exit', resolve)); }
  }
}
