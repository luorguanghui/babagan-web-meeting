import { screenShareBitrates, screenShareDefaultBitrate, type ScreenShareBitrate } from './screen-share.js';
const key = 'babagan.screen-bitrate-cap';
export function readScreenBitrate(): ScreenShareBitrate {
  try {
    const saved = Number(localStorage.getItem(key));
    if (screenShareBitrates.includes(saved as ScreenShareBitrate)) return saved as ScreenShareBitrate;
  } catch { /* Storage may be disabled; the in-memory selection still works. */ }
  return screenShareDefaultBitrate;
}
export function saveScreenBitrate(value: ScreenShareBitrate): void {
  try { localStorage.setItem(key, String(value)); } catch { /* Optional persistence. */ }
}
