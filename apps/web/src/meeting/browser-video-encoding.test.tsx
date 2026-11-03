import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyBrowserVideoCodecPreference } from './browser-video-encoding.js';

afterEach(() => vi.unstubAllGlobals());
const cb = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' };
const baseline = { ...cb, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42001f' };
const high = { ...cb, sdpFmtpLine: 'packetization-mode=1;profile-level-id=640032' };
const rtx = { mimeType: 'video/rtx', clockRate: 90000 };
const vp8 = { mimeType: 'video/VP8', clockRate: 90000 };
const options = { codec: 'h264' as const, maxBitrate: 8_000_000, frameRate: 60, degradationPreference: 'maintain-framerate' as const };

describe('Cloudflare hardware-first codec offer', () => {
  it('prevents an SFU preference for software-only CBP from overriding hardware H264', async () => {
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [vp8, cb, baseline, high, rtx] }) });
    vi.stubGlobal('navigator', { mediaCapabilities: { encodingInfo: vi.fn(async (config: MediaEncodingConfiguration) => ({
      supported: true, powerEfficient: !config.video!.contentType.includes('42e01f')
    })) } });
    const setCodecPreferences = vi.fn();
    await applyBrowserVideoCodecPreference({ setCodecPreferences } as unknown as RTCRtpTransceiver, options, 'hardware', { width: 5120, height: 2160 });
    expect(navigator.mediaCapabilities.encodingInfo).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ width: 2560, height: 1080 }) }));
    const offered = setCodecPreferences.mock.calls[0][0] as RTCRtpCodec[];
    expect(offered).toEqual([high, baseline, rtx]);
    // Real SFU answer chooses CBP if present, regardless of its offer position.
    const chosen = offered.find(c => c.sdpFmtpLine?.includes('42e01f')) ?? offered[0];
    expect(chosen).toBe(high);
  });
  it('keeps the established fallback offer in compatibility mode', async () => {
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [vp8, cb, high, rtx] }) });
    const encodingInfo = vi.fn(); vi.stubGlobal('navigator', { mediaCapabilities: { encodingInfo } });
    const setCodecPreferences = vi.fn();
    await applyBrowserVideoCodecPreference({ setCodecPreferences } as unknown as RTCRtpTransceiver, options, 'compatible', {});
    expect(setCodecPreferences).toHaveBeenCalledWith([high, cb, vp8, rtx]);
    expect(encodingInfo).not.toHaveBeenCalled();
  });
  it.each(['unavailable', 'software', 'throws'])('falls back safely when hardware capability is %s', async mode => {
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [vp8, cb, high, rtx] }) });
    vi.stubGlobal('navigator', mode === 'unavailable' ? {} : { mediaCapabilities: { encodingInfo: async () => {
      if (mode === 'throws') throw new Error('unsupported capability query');
      return { supported: true, powerEfficient: false };
    } } });
    const setCodecPreferences = vi.fn();
    await applyBrowserVideoCodecPreference({ setCodecPreferences } as unknown as RTCRtpTransceiver, options, 'hardware', {});
    expect(setCodecPreferences).toHaveBeenCalledWith([high, cb, vp8, rtx]);
  });
  it('bounds an unresponsive capability probe and retains compatibility', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [cb, high, rtx] }) });
      vi.stubGlobal('navigator', { mediaCapabilities: { encodingInfo: () => new Promise(() => {}) } });
      const setCodecPreferences = vi.fn();
      const pending = applyBrowserVideoCodecPreference({ setCodecPreferences } as unknown as RTCRtpTransceiver, options, 'hardware', {});
      await vi.advanceTimersByTimeAsync(1000); await pending;
      expect(setCodecPreferences).toHaveBeenCalledWith([high, cb, rtx]);
    } finally { vi.useRealTimers(); }
  });
});
