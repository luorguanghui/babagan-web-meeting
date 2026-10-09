#!/usr/bin/env node
/* global WebSocket, URL, console, setTimeout, clearTimeout */
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function verifyRtcWebSocket(rtcUrl, token, { WebSocketImpl = WebSocket, timeoutMs = 10_000 } = {}) {
  const url = new URL(rtcUrl);
  if (url.protocol !== 'wss:') throw new Error('RTC verification requires WSS.');
  url.searchParams.set('access_token', token);
  return new Promise((resolve, reject) => {
    let settled = false;
    let opened = false;
    const socket = new WebSocketImpl(url);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error(error));
      else resolve('WebSocket upgrade, open and initial message succeeded.');
      try { socket.close(1000, 'smoke check complete'); } catch { /* already closed */ }
    };
    const timer = setTimeout(() => finish('WebSocket did not deliver an initial message within the deadline.'), timeoutMs);
    socket.addEventListener('open', () => { opened = true; });
    // Closing in `open` races the server's first signaling write and can
    // falsely fail a healthy endpoint. Wait for actual signaling instead.
    socket.addEventListener('message', () => { if (opened) finish(); });
    socket.addEventListener('error', () => finish('WebSocket connection failed.'));
    socket.addEventListener('close', () => finish('WebSocket closed before an initial message.'));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [rtcUrl] = process.argv.slice(2);
  const token = process.env.SMOKE_LIVEKIT_TOKEN;
  if (!rtcUrl || !token) {
    console.error('Usage: SMOKE_LIVEKIT_TOKEN=token node scripts/verify-websocket.mjs wss://rtc.example.com');
    process.exitCode = 64;
  } else {
    try { console.log(await verifyRtcWebSocket(rtcUrl, token)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
