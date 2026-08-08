#!/usr/bin/env node
/* global URL, window, navigator, document, setTimeout, console */
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

if (!baseURL || !adminPassword) {
  throw new Error('LOAD_BASE_URL and LOAD_ADMIN_PASSWORD are required. Run only against an approved non-production or scheduled acceptance environment.');
}
if (!Number.isInteger(durationSeconds) || durationSeconds < intervalSeconds) {
  throw new Error(`LOAD_DURATION_SECONDS must be an integer of at least ${intervalSeconds}.`);
}

mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const metricsFile = resolve(outputDirectory, 'server-metrics.ndjson');
const webrtcFile = resolve(outputDirectory, 'webrtc-stats.ndjson');
const reportFile = resolve(outputDirectory, 'summary.json');
const composeFile = resolve(import.meta.dirname, '..', 'infra', 'docker-compose.yml');
const windowsUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';

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
            canvas.getContext('2d')?.fillRect(0, 0, canvas.width, canvas.height);
            return canvas.captureStream(60);
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

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
});
const contexts = [];
let stopped = false;
const stop = () => { stopped = true; };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
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

  const startedAt = Date.now();
  while (!stopped && Date.now() - startedAt < durationSeconds * 1_000) {
    const timestamp = new Date().toISOString();
    const stats = await Promise.all(pages.map((page, participant) => page.evaluate(async () => ({
      connections: await window.__meetingCollectWebRtcStats()
    })).then((value) => ({ timestamp, participant, ...value }))));
    for (const stat of stats) appendFileSync(webrtcFile, `${JSON.stringify(stat)}\n`, { mode: 0o600 });
    appendFileSync(metricsFile, `${JSON.stringify({
      timestamp,
      cpuAndRss: dockerStats(),
      outboundBytes: outboundBytes(),
      api5xx: api5xxCount()
    })}\n`, { mode: 0o600 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalSeconds * 1_000));
  }

  const summary = JSON.parse(command(process.execPath, [resolve(import.meta.dirname, 'collect-webrtc-stats.mjs'), webrtcFile]));
  writeFileSync(reportFile, JSON.stringify({
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    requestedDurationSeconds: durationSeconds,
    sampleIntervalSeconds: intervalSeconds,
    scenario: 'one room, five microphone publishers, one 1920x1080@60 screen publisher, four screen subscribers',
    webrtc: summary,
    metricsFile,
    webrtcFile
  }, null, 2), { mode: 0o600 });
  console.log(`Load test evidence written to ${outputDirectory}`);
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
