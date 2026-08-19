#!/usr/bin/env node
/* global WebSocket, URL, console, setTimeout, clearTimeout */
import process from 'node:process';

const [rtcUrl] = process.argv.slice(2);
const token = process.env.SMOKE_LIVEKIT_TOKEN;
if (!rtcUrl || !token) {
  console.error('Usage: SMOKE_LIVEKIT_TOKEN=token node scripts/verify-websocket.mjs wss://rtc.example.com');
  process.exit(64);
}

const url = new URL(rtcUrl);
url.searchParams.set('access_token', token);
let settled = false;
const finish = (code, message) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (code === 0) console.log(message);
  else console.error(message);
  process.exit(code);
};
const timer = setTimeout(() => finish(1, 'WebSocket did not open within 10 seconds.'), 10_000);
const socket = new WebSocket(url);
let opened = false;
socket.addEventListener('open', () => {
  opened = true;
  socket.close(1000, 'smoke check complete');
});
socket.addEventListener('error', () => finish(1, 'WebSocket connection failed.'));
socket.addEventListener('close', () => finish(
  opened ? 0 : 1,
  opened ? 'WebSocket upgrade and open succeeded.' : 'WebSocket closed before opening.'
));
