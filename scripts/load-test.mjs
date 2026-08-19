#!/usr/bin/env node
/* global URL, window, navigator, document, setTimeout, console, requestAnimationFrame, AudioContext, MediaStream, fetch */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const baseURL = process.env.LOAD_BASE_URL;
const adminPassword = process.env.LOAD_ADMIN_PASSWORD;
const durationSeconds = Number(process.env.LOAD_DURATION_SECONDS ?? 7_200);
const intervalSeconds = 10;
const outputDirectory = resolve(process.env.LOAD_OUTPUT_DIRECTORY ?? `artifacts/load-${new Date().toISOString().replaceAll(':', '')}`);
const metricsSource = process.env.LOAD_METRICS_SOURCE ?? 'local-compose';

if (!baseURL || !adminPassword) {
  throw new Error('LOAD_BASE_URL and LOAD_ADMIN_PASSWORD are required. Run only against an approved non-production or scheduled acceptance environment.');
}
if (!Number.isInteger(durationSeconds) || durationSeconds < intervalSeconds || durationSeconds > 7_200) {
  throw new Error(`LOAD_DURATION_SECONDS must be an integer from ${intervalSeconds} through 7200 seconds.`);
}

mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const metricsFile = resolve(outputDirectory, 'server-metrics.ndjson');
const webrtcFile = resolve(outputDirectory, 'webrtc-stats.ndjson');
const reportFile = resolve(outputDirectory, 'summary.json');
const composeFile = resolve(import.meta.dirname, '..', 'infra', 'docker-compose.yml');
const windowsUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const target = new URL(baseURL);
const normalizedTarget = target.origin;
const isLocalTarget = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);

function command(commandName, args) {
  return execFileSync(commandName, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function dockerStats() {
  const containers = command('docker', ['compose', '-f', composeFile, 'ps', '-q']).split('\n').filter(Boolean);
  const statistics = containers.length === 0 ? [] : command('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...containers])
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const restarts = containers.map((id) => ({ id, restartCount: Number(command('docker', ['inspect', '--format', '{{.RestartCount}}', id])) }));
  return { containers: statistics, restarts };
}

function outboundBytes() {
  const interfaces = JSON.parse(command('ip', ['-j', '-s', 'link']));
  return interfaces.reduce((sum, item) => sum + Number(item.stats64?.tx?.bytes ?? item.stats?.tx?.bytes ?? 0), 0);
}

function api5xxCount() {
  const logs = command('docker', ['compose', '-f', composeFile, 'logs', '--no-color', 'api']);
  return (logs.match(/\b5\d\d\b/g) ?? []).length;
}

function verifyLocalComposeTarget() {
  if (!isLocalTarget) throw new Error('LOAD_METRICS_SOURCE=local-compose is restricted to localhost. Use an authenticated remote metrics source for a remote target.');
  const services = command('docker', ['compose', '-f', composeFile, 'config', '--services']).split('\n').filter(Boolean);
  for (const service of ['api', 'caddy', 'livekit']) {
    if (!services.includes(service)) throw new Error(`Local Compose configuration is missing required service: ${service}.`);
  }
  const containers = command('docker', ['compose', '-f', composeFile, 'ps', '-q', 'api', 'caddy', 'livekit']).split('\n').filter(Boolean);
  if (containers.length !== 3) throw new Error('Refusing to sample host metrics: the local target is not backed by all expected Compose services.');
}

async function verifyRemoteMetricsTarget() {
  if (process.env.LOAD_ALLOW_REMOTE !== '1') throw new Error('Remote load testing requires LOAD_ALLOW_REMOTE=1.');
  const metricsUrl = process.env.LOAD_REMOTE_METRICS_URL;
  const token = process.env.LOAD_REMOTE_METRICS_TOKEN;
  if (!metricsUrl || !token) throw new Error('Remote load testing requires LOAD_REMOTE_METRICS_URL and LOAD_REMOTE_METRICS_TOKEN.');
  const response = await fetch(metricsUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Authenticated remote metrics preflight failed with HTTP ${response.status}.`);
  const identity = await response.json();
  if (identity.targetOrigin !== normalizedTarget || identity.service !== 'babagan-meeting' || identity.authenticated !== true) {
    throw new Error('Remote metrics identity does not attest to this meeting target; refusing to record unrelated host metrics.');
  }
}

async function prepareMetricsSource() {
  if (metricsSource === 'local-compose') {
    verifyLocalComposeTarget();
    return () => ({
      cpuAndRss: dockerStats(),
      outboundBytes: outboundBytes(),
      api5xx: api5xxCount()
    });
  }
  if (metricsSource === 'remote') {
    await verifyRemoteMetricsTarget();
    const metricsUrl = process.env.LOAD_REMOTE_METRICS_URL;
    const token = process.env.LOAD_REMOTE_METRICS_TOKEN;
    return async () => {
      const response = await fetch(metricsUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Remote metrics sample failed with HTTP ${response.status}.`);
      const metrics = await response.json();
      if (metrics.targetOrigin !== normalizedTarget || metrics.service !== 'babagan-meeting' || metrics.authenticated !== true) {
        throw new Error('Remote metrics identity changed during the load test.');
      }
      return metrics;
    };
  }
  throw new Error('LOAD_METRICS_SOURCE must be local-compose or remote.');
}

async function installSyntheticMedia(context) {
  await context.addInitScript(() => {
    const original = window.RTCPeerConnection;
    const connections = [];
    if (original) {
      function InstrumentedPeerConnection(...args) {
        const connection = new original(...args);
        connections.push(connection);
        return connection;
      }
      InstrumentedPeerConnection.prototype = original.prototype;
      Object.setPrototypeOf(InstrumentedPeerConnection, original);
      window.RTCPeerConnection = InstrumentedPeerConnection;
    }
    window.__meetingCollectWebRtcStats = async () => Promise.all(connections.map(async (connection) => ({
      connectionState: connection.connectionState,
      stats: [...(await connection.getStats()).values()].map((stat) => stat.toJSON ? stat.toJSON() : stat)
    })));
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: mediaDevices.getUserMedia.bind(mediaDevices),
          enumerateDevices: mediaDevices.enumerateDevices.bind(mediaDevices),
          getDisplayMedia: async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 1920;
            canvas.height = 1080;
            const drawing = canvas.getContext('2d');
            let paintedFrames = 0;
            const animate = (now) => {
              if (!drawing) return;
              const hue = Math.floor(now / 8) % 360;
              drawing.fillStyle = `hsl(${hue} 85% 50%)`;
              drawing.fillRect(0, 0, canvas.width, canvas.height);
              drawing.fillStyle = '#101820';
              drawing.fillRect((paintedFrames * 29) % canvas.width, 160, 480, 180);
              drawing.fillStyle = '#ffffff';
              drawing.font = '72px sans-serif';
              drawing.fillText(`Synthetic frame ${paintedFrames}`, 80, 100);
              paintedFrames += 1;
              requestAnimationFrame(animate);
            };
            requestAnimationFrame(animate);
            const videoStream = canvas.captureStream(60);
            const audioContext = new AudioContext();
            const destination = audioContext.createMediaStreamDestination();
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            gain.gain.value = 0.001;
            oscillator.connect(gain).connect(destination);
            oscillator.start();
            void audioContext.resume();
            const stream = new MediaStream([...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
            window.__meetingSyntheticScreenInfo = () => ({
              paintedFrames,
              video: videoStream.getVideoTracks()[0]?.getSettings(),
              audioTracks: destination.stream.getAudioTracks().length
            });
            return stream;
          }
        }
      });
    }
  });
}

async function join(page, url, name) {
  await page.goto(url);
  await page.getByLabel('Nickname').fill(name);
  await page.getByRole('button', { name: 'Join muted' }).click();
  await page.getByRole('status', { name: /Connection: connected/i }).waitFor();
}

async function createMeeting(page) {
  await page.goto(`${baseURL.replace(/\/$/, '')}/create`);
  await page.getByLabel('Meeting name').fill(`Load test ${Date.now()}`);
  await page.getByLabel('Admin password').fill(adminPassword);
  await page.getByRole('button', { name: 'Create meeting' }).click();
  const link = page.getByRole('link', { name: 'Enter as host' });
  await link.waitFor();
  const href = await link.getAttribute('href');
  if (!href) throw new Error('Load meeting creation did not return a join URL.');
  return href;
}

const contexts = [];
let stopped = false;
const stop = () => { stopped = true; };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let browser;

try {
  const sampleMetrics = await prepareMetricsSource();
  browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
  });
  const hostContext = await browser.newContext({ userAgent: windowsUserAgent });
  contexts.push(hostContext);
  await installSyntheticMedia(hostContext);
  const host = await hostContext.newPage();
  const meetingUrl = await createMeeting(host);
  await join(host, meetingUrl, 'Load host');

  const pages = [host];
  for (const nickname of ['Load one', 'Load two', 'Load three', 'Load four']) {
    const context = await browser.newContext({ userAgent: windowsUserAgent });
    contexts.push(context);
    await installSyntheticMedia(context);
    const page = await context.newPage();
    await join(page, meetingUrl, nickname);
    pages.push(page);
  }
  for (const page of pages) await page.getByRole('button', { name: 'Unmute microphone' }).click();
  await host.getByRole('button', { name: 'Grant screen sharing to Load host' }).click();
  await host.getByRole('button', { name: 'Share screen' }).click();
  await host.waitForFunction(() => {
    const stream = window.__meetingSyntheticScreenInfo?.();
    return stream?.paintedFrames > 30
      && stream.video?.width === 1920
      && stream.video?.height === 1080
      && stream.video?.frameRate === 60
      && stream.audioTracks === 1;
  });
  await Promise.all(pages.slice(1).map((page) => page.waitForFunction(async () => {
    const connections = await window.__meetingCollectWebRtcStats();
    return connections.some(({ stats }) => stats.some((stat) => stat.type === 'inbound-rtp'
      && stat.kind === 'video'
      && Number(stat.bytesReceived ?? 0) > 0
      && Number(stat.framesDecoded ?? 0) > 0));
  }, undefined, { timeout: 30_000 })));

  const startedAt = Date.now();
  while (!stopped && Date.now() - startedAt < durationSeconds * 1_000) {
    const timestamp = new Date().toISOString();
    const stats = await Promise.all(pages.map((page, participant) => page.evaluate(async () => ({
      connections: await window.__meetingCollectWebRtcStats()
    })).then((value) => ({ timestamp, participant, ...value }))));
    for (const stat of stats) appendFileSync(webrtcFile, `${JSON.stringify(stat)}\n`, { mode: 0o600 });
    appendFileSync(metricsFile, `${JSON.stringify({
      timestamp,
      metrics: await sampleMetrics()
    })}\n`, { mode: 0o600 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalSeconds * 1_000));
  }

  const summary = JSON.parse(command(process.execPath, [resolve(import.meta.dirname, 'collect-webrtc-stats.mjs'), webrtcFile]));
  writeFileSync(reportFile, JSON.stringify({
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    requestedDurationSeconds: durationSeconds,
    sampleIntervalSeconds: intervalSeconds,
    scenario: 'one room, five microphone publishers, one animated 1920x1080@60 screen publisher with synthetic audio, four verified screen subscribers',
    metricsSource,
    webrtc: summary,
    metricsFile,
    webrtcFile
  }, null, 2), { mode: 0o600 });
  console.log(`Load test evidence written to ${outputDirectory}`);
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser?.close();
}
