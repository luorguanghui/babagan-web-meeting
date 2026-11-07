// Synthetic pixels only: this benchmark never invokes ddagrab or accesses a display.
import { spawn } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { createCaptureSession } from '../dist/capture.js';
import { createNativeCaptureServer } from '../dist/server.js';
import { Y4mParser } from '../dist/y4m.js';

const ffmpeg = process.argv[2];
if (!ffmpeg) throw new Error('Supply an FFmpeg executable path. Only testsrc2 is used.');
const frameCount = 240;
const spawnSynthetic = (paced, timestamps = true) => () => spawn(ffmpeg, [
  '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
  ...(paced ? ['-re'] : []), '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60',
  ...(timestamps ? ['-vf', 'showinfo=checksum=0'] : []), '-frames:v', String(frameCount), '-an', '-pix_fmt', 'yuv420p',
  '-fps_mode', 'passthrough', '-f', 'yuv4mpegpipe', 'pipe:1'
], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

async function rawParser() {
  let frames = 0;
  const parser = new Y4mParser({ onFormat() {}, onFrame() { frames++; } });
  const start = performance.now();
  const cpu = process.cpuUsage();
  const child = spawnSynthetic(false, false)();
  child.stdout.on('data', (chunk) => parser.push(chunk));
  child.stderr.resume();
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Synthetic source failed'))); });
  parser.finish();
  const seconds = (performance.now() - start) / 1000;
  return { mode: 'unpaced_ffmpeg_pipe_y4m_parser_only', frames, seconds, fps: frames / seconds, nodeCpu: process.cpuUsage(cpu) };
}

async function timestampedParser() {
  let frames = 0;
  const errors = [];
  const start = performance.now();
  const cpu = process.cpuUsage();
  const capture = createCaptureSession({ ffmpeg, frameRate: 60, getActiveDisplayCount: async () => 1,
    spawnProcess: spawnSynthetic(true), onFormat() {}, onFrame() { frames++; }, onError(code) { errors.push(code); } });
  await capture.done;
  const seconds = (performance.now() - start) / 1000;
  return { mode: 'realtime60_ffmpeg_pipe_parser_pts', frames, seconds, fps: frames / seconds, nodeCpu: process.cpuUsage(cpu), errors };
}

async function websocket(paced) {
  const helper = await createNativeCaptureServer({ ffmpeg, origin: 'http://127.0.0.1:5188', getActiveDisplayCount: async () => 1,
    spawnProcess: spawnSynthetic(paced), statsIntervalMs: 100, idleTimeoutMs: 10_000 });
  const client = new WebSocket(`ws://127.0.0.1:${helper.port}/frames`, ['babagan-native-v1', `auth.${helper.token}`], { origin: helper.origin });
  let frames = 0;
  let first = 0;
  let last = 0;
  let counters;
  const errors = [];
  const cpu = process.cpuUsage();
  const start = performance.now();
  await new Promise((resolve, reject) => {
    client.on('open', () => client.send(JSON.stringify({ type: 'start', frameRate: 60 })));
    client.on('message', (data, binary) => {
      if (binary) {
        const now = performance.now();
        first ||= now;
        last = now;
        frames++;
      } else {
        const control = JSON.parse(data.toString());
        if (control.type === 'stats') counters = control;
        if (control.type === 'error') errors.push(control.code);
        if (control.type === 'stopped') resolve();
      }
    });
    client.on('error', reject);
    client.on('close', resolve);
  });
  const seconds = (performance.now() - start) / 1000;
  client.terminate();
  await helper.close();
  return { mode: paced ? 'realtime60_ffmpeg_pipe_parser_websocket' : 'unpaced_ffmpeg_pipe_parser_websocket',
    frames, seconds, fps: frames / seconds, steadyFps: (frames - 1) / ((last - first) / 1000), counters, nodeCpu: process.cpuUsage(cpu), errors };
}

for (const run of [rawParser, timestampedParser, () => websocket(true)]) console.log(JSON.stringify(await run()));
