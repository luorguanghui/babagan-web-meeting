import type { ScreenShareCodec } from '@meeting/contracts';

/**
 * Orders the transceiver's codec list so the chosen codec is preferred during
 * SDP negotiation. `auto` keeps the browser default. Best-effort: browsers
 * without `RTCRtpSender.getCapabilities` (or without `setCodecPreferences`)
 * simply use their default codec.
 */
export function applyScreenVideoCodecPreference(transceiver: RTCRtpTransceiver, codec: ScreenShareCodec): void {
  if (codec === 'auto' || typeof transceiver.setCodecPreferences !== 'function') return;
  const capabilities = typeof RTCRtpSender !== 'undefined'
    ? RTCRtpSender.getCapabilities?.('video')?.codecs
    : undefined;
  if (!capabilities || capabilities.length === 0) return;
  const wanted = codec === 'h264' ? 'video/h264' : 'video/vp8';
  const matching = capabilities.filter((codecCapability) => codecCapability.mimeType.toLowerCase() === wanted);
  if (matching.length === 0) return;
  const preferred = matching
    // Chromium advertises Baseline before High. High can improve motion coding at
    // the same bitrate without lowering resolution. Only reorder capabilities
    // the browser actually exposes; keep Baseline and other codecs for peers
    // that cannot negotiate High. Stable sorting retains every fallback order.
    .sort((a, b) => codec === 'h264' ? Number(isH264HighProfile(b)) - Number(isH264HighProfile(a)) : 0)
    .concat(capabilities.filter((codecCapability) => codecCapability.mimeType.toLowerCase() !== wanted));
  if (preferred.length > 0) transceiver.setCodecPreferences(preferred);
}

function isH264HighProfile(codec: RTCRtpCodec): boolean {
  const fmtp = codec.sdpFmtpLine ?? '';
  return /(?:^|;)\s*profile-level-id\s*=\s*64(?:00|0c)[0-9a-f]{2}\s*(?:;|$)/i.test(fmtp)
    && /(?:^|;)\s*packetization-mode\s*=\s*1\s*(?:;|$)/i.test(fmtp);
}

