import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyBrowserVideoCodecPreference, nativeHardwareAv1Encoding } from './browser-video-encoding.js';

afterEach(() => vi.unstubAllGlobals());
const cb = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' };
const baseline = { ...cb, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42001f' };
const high = { ...cb, sdpFmtpLine: 'packetization-mode=1;profile-level-id=640032' };
const main = { ...cb, sdpFmtpLine: 'packetization-mode=1;profile-level-id=4d0032' };
const av1 = { mimeType: 'video/AV1', clockRate: 90000, sdpFmtpLine: 'level-idx=5;profile=0;tier=0' };
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
  it('preserves the existing hardware H264 non-High fallback order for an explicit codec', async () => {
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [main, baseline, high, rtx] }) });
    vi.stubGlobal('navigator', { mediaCapabilities: { encodingInfo: async () => ({ supported: true, powerEfficient: true }) } });
    const setCodecPreferences = vi.fn();
    await applyBrowserVideoCodecPreference({ setCodecPreferences } as unknown as RTCRtpTransceiver, { ...options, nativeCapture: true }, 'hardware', {});
    expect(setCodecPreferences).toHaveBeenCalledWith([high, main, baseline, rtx]);
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

describe('native capture hardware Auto offer', () => {
  const nativeOptions = { ...options, codec: 'auto' as const, nativeCapture: true, maxBitrate: 20_000_000 };
  it('prefers verified hardware AV1 at the scaled capture dimensions and retains hardware H264 and repair fallbacks', async () => {
    const packetizationZero = { ...high, sdpFmtpLine: 'packetization-mode=0;profile-level-id=640032' };
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [vp8, main, cb, baseline, av1, high, packetizationZero, rtx] }) });
    const encodingInfo = vi.fn(async (config: MediaEncodingConfiguration) => ({ supported: true, powerEfficient: !config.video!.contentType.includes('42e01f') }));
    vi.stubGlobal('navigator', { mediaCapabilities: { encodingInfo } });
    const setCodecPreferences = vi.fn();
    const result = await applyBrowserVideoCodecPreference({ setCodecPreferences } as unknown as RTCRtpTransceiver, nativeOptions, 'hardware', { width: 3840, height: 2160 });
    expect(encodingInfo).toHaveBeenCalledWith({ type: 'webrtc', video: {
      contentType: 'video/AV1;level-idx=5;profile=0;tier=0', width: 1920, height: 1080, bitrate: 20_000_000, framerate: 60
    } });
    expect(encodingInfo.mock.calls.some(([config]) => config.video!.contentType.includes('packetization-mode=0'))).toBe(false);
    expect(setCodecPreferences).toHaveBeenCalledWith([av1, high, baseline, main, rtx]);
    expect(result).toEqual({ preferredHardwareCodec: 'av1' });
  });

  it('prefers verified hardware H264 when advertised AV1 has no efficient encoder', async () => {
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [av1, baseline, high, rtx] }) });
    vi.stubGlobal('navigator', { mediaCapabilities: { encodingInfo: async (config: MediaEncodingConfiguration) => ({ supported: true, powerEfficient: !config.video!.contentType.startsWith('video/AV1') }) } });
    const setCodecPreferences = vi.fn();
    expect(await applyBrowserVideoCodecPreference({ setCodecPreferences } as unknown as RTCRtpTransceiver, nativeOptions, 'hardware', {})).toEqual({ preferredHardwareCodec: 'h264' });
    expect(setCodecPreferences).toHaveBeenCalledWith([high, baseline, rtx]);
  });

  it.each(['absent', 'software', 'unsupported', 'throws'])('leaves Auto negotiation unchanged when capability is %s', async mode => {
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [av1, high, vp8, rtx] }) });
    vi.stubGlobal('navigator', mode === 'absent' ? {} : { mediaCapabilities: { encodingInfo: async () => {
      if (mode === 'throws') throw new Error('Unsupported query');
      return { supported: mode !== 'unsupported', powerEfficient: mode !== 'software' };
    } } });
    const setCodecPreferences = vi.fn();
    expect(await applyBrowserVideoCodecPreference({ setCodecPreferences } as unknown as RTCRtpTransceiver, nativeOptions, 'hardware', {})).toBeUndefined();
    expect(setCodecPreferences).not.toHaveBeenCalled();
  });

  it.each(['h264', 'vp8'] as const)('preserves the explicit %s codec even for native capture', async codec => {
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [av1, baseline, high, vp8, rtx] }) });
    const encodingInfo = vi.fn<(config: MediaEncodingConfiguration) => Promise<{ supported: boolean; powerEfficient: boolean }>>().mockResolvedValue({ supported: true, powerEfficient: true });
    vi.stubGlobal('navigator', { mediaCapabilities: { encodingInfo } });
    const setCodecPreferences = vi.fn();
    const result = await applyBrowserVideoCodecPreference({ setCodecPreferences } as unknown as RTCRtpTransceiver, { ...nativeOptions, codec }, 'hardware', {});
    expect((setCodecPreferences.mock.calls[0][0] as RTCRtpCodec[])[0].mimeType).toBe(codec === 'h264' ? 'video/H264' : 'video/VP8');
    expect(encodingInfo.mock.calls.some(([config]) => (config as MediaEncodingConfiguration).video!.contentType.startsWith('video/AV1'))).toBe(false);
    expect(result?.preferredHardwareCodec).not.toBe('av1');
  });

  it.each([['browser-auto', false, 'hardware'], ['native-compatible', true, 'compatible']] as const)('does not alter %s negotiation', async (_mode, nativeCapture, preference) => {
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [av1, high, rtx] }) });
    const encodingInfo = vi.fn(); vi.stubGlobal('navigator', { mediaCapabilities: { encodingInfo } });
    const setCodecPreferences = vi.fn();
    await applyBrowserVideoCodecPreference({ setCodecPreferences } as unknown as RTCRtpTransceiver, { ...nativeOptions, nativeCapture }, preference, {});
    expect(encodingInfo).not.toHaveBeenCalled(); expect(setCodecPreferences).not.toHaveBeenCalled();
  });

  it('bounds native hardware detection and never applies late results after fallback', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [av1, high, rtx] }) });
      let finish!: (result: { supported: boolean; powerEfficient: boolean }) => void;
      const query = new Promise<{ supported: boolean; powerEfficient: boolean }>(resolve => { finish = resolve; });
      vi.stubGlobal('navigator', { mediaCapabilities: { encodingInfo: () => query } });
      const setCodecPreferences = vi.fn();
      const pending = applyBrowserVideoCodecPreference({ setCodecPreferences } as unknown as RTCRtpTransceiver, nativeOptions, 'hardware', {});
      await vi.advanceTimersByTimeAsync(1000); expect(await pending).toBeUndefined();
      finish({ supported: true, powerEfficient: true }); await Promise.resolve(); await Promise.resolve();
      expect(setCodecPreferences).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe('negotiated native hardware AV1 scalability', () => {
  const parameters = (codecs: RTCRtpCodecParameters[], encoding: RTCRtpEncodingParameters = {}): RTCRtpSendParameters => ({ transactionId: 'test', codecs, headerExtensions: [], rtcp: {}, encodings: [encoding] });
  it('requests L1T1 only for an unambiguously negotiated hardware AV1 preference', () => {
    expect(nativeHardwareAv1Encoding({ preferredHardwareCodec: 'av1' }, parameters([{ ...av1, payloadType: 96 }, { ...rtx, payloadType: 97 }]))).toEqual({ scalabilityMode: 'L1T1' });
    expect(nativeHardwareAv1Encoding(undefined, parameters([{ ...av1, payloadType: 96 }]))).toEqual({});
    expect(nativeHardwareAv1Encoding({ preferredHardwareCodec: 'h264' }, parameters([{ ...av1, payloadType: 96 }]))).toEqual({});
  });
  it('does not impose an AV1 hint on H264 fallback or ambiguous/empty negotiated codec lists', () => {
    for (const codecs of [[], [{ ...high, payloadType: 98 }], [{ ...av1, payloadType: 96 }, { ...high, payloadType: 98 }]]) {
      expect(nativeHardwareAv1Encoding({ preferredHardwareCodec: 'av1' }, parameters(codecs))).toEqual({});
    }
  });
});
