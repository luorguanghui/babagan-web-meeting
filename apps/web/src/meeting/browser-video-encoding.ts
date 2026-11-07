import type { ScreenSharePublishOptions } from './screen-share.js';
import { applyScreenVideoCodecPreference } from './video-codec-preference.js';
import { computeResolutionScale } from './screen-resolution.js';

export type BrowserEncodingPreference = 'hardware' | 'compatible';
export interface BrowserCodecSelection { preferredHardwareCodec: 'av1' | 'h264'; }
export function nativeHardwareAv1Encoding(selection: BrowserCodecSelection | undefined, parameters: RTCRtpSendParameters): { scalabilityMode?: 'L1T1' } {
  if (selection?.preferredHardwareCodec !== 'av1') return {};
  const encoding = parameters.encodings?.[0] as (RTCRtpEncodingParameters & { codec?: RTCRtpCodec }) | undefined;
  const primary = (parameters.codecs ?? []).filter(codec => !/video\/(rtx|red|ulpfec|flexfec-03)$/i.test(codec.mimeType));
  const selectedAv1 = encoding?.codec ? encoding.codec.mimeType.toLowerCase() === 'video/av1'
    : primary.length > 0 && primary.every(codec => codec.mimeType.toLowerCase() === 'video/av1');
  return selectedAv1 ? { scalabilityMode: 'L1T1' } : {};
}

export async function applyBrowserVideoCodecPreference(
  transceiver: RTCRtpTransceiver, options: ScreenSharePublishOptions,
  preference: BrowserEncodingPreference, settings: MediaTrackSettings
): Promise<BrowserCodecSelection | undefined> {
  const capabilities = typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities?.('video')?.codecs : undefined;
  const mediaCapabilities = typeof navigator !== 'undefined' ? navigator.mediaCapabilities : undefined;
  const nativeAuto = options.nativeCapture === true && options.codec === 'auto';
  if (preference === 'hardware' && (options.codec === 'h264' || nativeAuto) && capabilities?.length
    && typeof transceiver.setCodecPreferences === 'function' && typeof mediaCapabilities?.encodingInfo === 'function') {
    const candidates = capabilities.filter(c => (nativeAuto && c.mimeType.toLowerCase() === 'video/av1')
      || (c.mimeType.toLowerCase() === 'video/h264'
      && /(?:^|;)\s*packetization-mode\s*=\s*1\s*(?:;|$)/i.test(c.sdpFmtpLine ?? '')));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const scale = computeResolutionScale(settings) ?? 1;
      const checks = Promise.all(candidates.map(async codec => {
        try {
          const result = await mediaCapabilities.encodingInfo({ type: 'webrtc', video: {
            contentType: `${codec.mimeType}${codec.sdpFmtpLine ? `;${codec.sdpFmtpLine}` : ''}`, width: Math.round((settings.width || 1920) / scale),
            height: Math.round((settings.height || 1080) / scale), bitrate: options.maxBitrate, framerate: options.frameRate
          } });
          return result.supported && result.powerEfficient ? codec : undefined;
        } catch { return undefined; }
      }));
      const checked: Array<RTCRtpCodec | undefined> = await Promise.race([checks, new Promise<undefined[]>(resolve => { timer = setTimeout(() => resolve([]), 1000); })]);
      const hardware = checked.filter((codec): codec is RTCRtpCodec => codec !== undefined)
        .sort((a, b) => nativeAuto ? hardwareCodecRank(a) - hardwareCodecRank(b)
          : Number(/profile-level-id\s*=\s*64/i.test(b.sdpFmtpLine ?? '')) - Number(/profile-level-id\s*=\s*64/i.test(a.sdpFmtpLine ?? '')));
      if (hardware.length) {
        // The SFU can choose software-only CBP even when High is first. Offer
        // only advertised, hardware-supported H264 profiles in this mode.
        transceiver.setCodecPreferences(hardware.concat(capabilities.filter(c => /video\/(rtx|red|ulpfec)$/i.test(c.mimeType))));
        return { preferredHardwareCodec: hardware[0].mimeType.toLowerCase() === 'video/av1' ? 'av1' : 'h264' };
      }
    } catch { /* An unsupported hint must retain the established codec path. */ }
    finally { clearTimeout(timer); }
  }
  applyScreenVideoCodecPreference(transceiver, options.codec);
}

function hardwareCodecRank(codec: RTCRtpCodec): number {
  if (codec.mimeType.toLowerCase() === 'video/av1') return 0;
  if (/profile-level-id\s*=\s*64/i.test(codec.sdpFmtpLine ?? '')) return 1;
  if (/profile-level-id\s*=\s*42/i.test(codec.sdpFmtpLine ?? '')) return 2;
  return 3;
}
