// Synthetic testsrc2 video only. No display acquisition is invoked by this diagnostic.
import { fork, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath } from 'node:url';
import { createCaptureSession } from '../dist/capture.js';

const origin = 'http://127.0.0.1:5188';
const ffmpeg = process.argv[2];
if (!ffmpeg) throw new Error('An FFmpeg executable is required; only testsrc2 is used.');

if (process.argv.includes('--helper')) {
  const token = randomBytes(32).toString('base64url');
  let capture;
  let captured = 0;
  let sent = 0;
  let dropped = 0;
  const server = createServer(async (request, response) => {
    if (request.headers.origin !== origin || request.url !== '/frames-http') { response.writeHead(403); response.end(); return; }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'authorization, content-type' }); response.end(); return;
    }
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}` || capture) { response.writeHead(403); response.end(); return; }
    let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024) { response.writeHead(413); response.end(); return; } }
    capture = createCaptureSession({ ffmpeg, frameRate: 60, getActiveDisplayCount: async () => 1,
      spawnProcess: () => spawn(ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-re', '-f', 'lavfi', '-i',
        'testsrc2=size=1920x1080:rate=60', '-vf', 'showinfo=checksum=0', '-frames:v', '600', '-an', '-pix_fmt', 'yuv420p',
        '-fps_mode', 'passthrough', '-f', 'yuv4mpegpipe', 'pipe:1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
      onFormat(format) {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
        const json = Buffer.from(JSON.stringify(format)); const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
        response.write(length); response.write(json);
      },
      onFrame({ frame, index, captureUs }) {
        captured++;
        if (response.destroyed || response.writableLength + frame.length + 16 > (frame.length + 16) * 2) { dropped++; return; }
        const header = Buffer.allocUnsafe(16); header.writeUInt32BE(0x424e4331); header.writeUInt32BE(index, 4); header.writeDoubleBE(captureUs, 8);
        response.cork(); response.write(header); response.write(frame, (error) => { if (error) dropped++; else sent++; }); response.uncork();
      }, onError(code) { process.send?.({ error: code }); response.destroy(); }
    });
    const active = capture;
    response.on('close', () => active.stop());
    await active.done;
    response.end();
    process.send?.({ stats: { captured, sent, dropped } });
    capture = undefined;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.send?.({ port: server.address().port, token });
  process.on('message', async () => { capture?.stop(); await capture?.done; server.closeAllConnections(); server.close(() => process.exit()); });
} else {
  const { chromium } = await import('../../web/node_modules/@playwright/test/index.mjs');
  const pageServer = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<title>Synthetic HTTP video transport test</title><p>Only generated test video is used.</p>'); });
  await new Promise((resolve) => pageServer.listen(5188, '127.0.0.1', resolve));
  const helper = fork(fileURLToPath(import.meta.url), [ffmpeg, '--helper'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let browser;
  let stats;
  const errors = [];
  helper.on('message', (message) => { if (message.stats) stats = message.stats; if (message.error) errors.push(message.error); });
  try {
    const config = await new Promise((resolve, reject) => { helper.once('message', resolve); helper.once('error', reject); });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage(); await page.goto(origin);
    const result = await page.evaluate(async ({ port, token }) => {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/frames-http`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ frameRate: 60 }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader({ mode: 'byob' });
      let reads = 0;
      async function exact(length, eof = false) {
        let buffer = new ArrayBuffer(length); let offset = 0;
        while (offset < length) {
          const result = await reader.read(new Uint8Array(buffer, offset, length - offset)); reads++;
          if (result.done) { if (eof && offset === 0) return; throw new Error('Truncated HTTP packet'); }
          buffer = result.value.buffer; offset += result.value.byteLength;
        }
        return buffer;
      }
      const metadataLength = new DataView(await exact(4)).getUint32(0);
      if (metadataLength > 4096) throw new Error('Invalid metadata');
      const format = JSON.parse(new globalThis.TextDecoder().decode(await exact(metadataLength)));
      const packetBytes = 16 + format.width * format.height * 3 / 2;
      let frames = 0; let first = 0; let last = 0; let previousSequence = -1;
      for (;;) {
        const buffer = await exact(packetBytes, true); if (!buffer) break;
        const header = new DataView(buffer);
        if (header.getUint32(0) !== 0x424e4331 || header.getUint32(4) <= previousSequence) throw new Error('Invalid frame');
        previousSequence = header.getUint32(4);
        const now = globalThis.performance.now(); first ||= now; last = now; frames++;
      }
      return { format, frames, reads, seconds: (last - first) / 1000, fps: (frames - 1) * 1000 / (last - first) };
    }, config);
    console.log(JSON.stringify({ ...result, stats, errors }));
  } finally {
    await browser?.close();
    if (helper.connected) { helper.send('stop'); await new Promise((resolve) => helper.once('exit', resolve)); }
    await new Promise((resolve) => pageServer.close(resolve));
  }
}
