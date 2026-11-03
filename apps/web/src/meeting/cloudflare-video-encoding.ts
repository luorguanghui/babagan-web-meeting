import type { ScreenSharePublishOptions } from './screen-share.js';
import { applyScreenVideoCodecPreference } from './video-codec-preference.js';
import { computeResolutionScale } from './screen-resolution.js';

export type CloudflareEncodingPreference = 'hardware' | 'compatible';

export async function applyCloudflareVideoCodecPreference(
  transceiver: RTCRtpTransceiver, options: ScreenSharePublishOptions,
  preference: CloudflareEncodingPreference, settings: MediaTrackSettings
): Promise<void> {
  const capabilities = typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities?.('video')?.codecs : undefined;
  const mediaCapabilities = typeof navigator !== 'undefined' ? navigator.mediaCapabilities : undefined;
  if (preference === 'hardware' && options.codec === 'h264' && capabilities?.length
    && typeof transceiver.setCodecPreferences === 'function' && typeof mediaCapabilities?.encodingInfo === 'function') {
    const candidates = capabilities.filter(c => c.mimeType.toLowerCase() === 'video/h264'
      && /(?:^|;)\s*packetization-mode\s*=\s*1\s*(?:;|$)/i.test(c.sdpFmtpLine ?? ''));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const scale = computeResolutionScale(settings) ?? 1;
      const checks = Promise.all(candidates.map(async codec => {
        try {
          const result = await mediaCapabilities.encodingInfo({ type: 'webrtc', video: {
            contentType: `${codec.mimeType};${codec.sdpFmtpLine}`, width: Math.round((settings.width || 1920) / scale),
            height: Math.round((settings.height || 1080) / scale), bitrate: options.maxBitrate, framerate: options.frameRate
          } });
          return result.supported && result.powerEfficient ? codec : undefined;
        } catch { return undefined; }
      }));
      const checked: Array<RTCRtpCodec | undefined> = await Promise.race([checks, new Promise<undefined[]>(resolve => { timer = setTimeout(() => resolve([]), 1000); })]);
      const hardware = checked.filter((codec): codec is RTCRtpCodec => codec !== undefined)
        .sort((a, b) => Number(/profile-level-id\s*=\s*64/i.test(b.sdpFmtpLine ?? '')) - Number(/profile-level-id\s*=\s*64/i.test(a.sdpFmtpLine ?? '')));
      if (hardware.length) {
        // The SFU can choose software-only CBP even when High is first. Offer
        // only advertised, hardware-supported H264 profiles in this mode.
        transceiver.setCodecPreferences(hardware.concat(capabilities.filter(c => /video\/(rtx|red|ulpfec)$/i.test(c.mimeType))));
        return;
      }
    } catch { /* An unsupported hint must retain the established codec path. */ }
    finally { clearTimeout(timer); }
  }
  applyScreenVideoCodecPreference(transceiver, options.codec);
}
