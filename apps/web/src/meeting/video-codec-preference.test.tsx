import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyScreenVideoCodecPreference } from './video-codec-preference.js';

afterEach(() => vi.unstubAllGlobals());

describe('screen video codec compatibility', () => {
  it.each(['missing-sender', 'missing-capabilities', 'missing-setter', 'missing-codec'])(
    'keeps browser defaults for %s', (unsupported) => {
      const setCodecPreferences = vi.fn();
      const transceiver = { setCodecPreferences } as unknown as RTCRtpTransceiver;
      vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] }) });
      if (unsupported === 'missing-sender') vi.stubGlobal('RTCRtpSender', undefined);
      if (unsupported === 'missing-capabilities') vi.stubGlobal('RTCRtpSender', {});
      if (unsupported === 'missing-setter') Object.defineProperty(transceiver, 'setCodecPreferences', { value: undefined });
      if (unsupported === 'missing-codec') vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) });
      expect(() => applyScreenVideoCodecPreference(transceiver, 'h264')).not.toThrow();
      expect(setCodecPreferences).not.toHaveBeenCalled();
    }
  );

  it('preserves VP8 selection and automatic codec choice', () => {
    const high = { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=64001f;packetization-mode=1' };
    const vp8 = { mimeType: 'video/VP8' };
    const rtx = { mimeType: 'video/rtx' };
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [high, rtx, vp8] }) });
    const setCodecPreferences = vi.fn();
    const transceiver = { setCodecPreferences } as unknown as RTCRtpTransceiver;
    applyScreenVideoCodecPreference(transceiver, 'auto');
    expect(setCodecPreferences).not.toHaveBeenCalled();
    applyScreenVideoCodecPreference(transceiver, 'vp8');
    expect(setCodecPreferences).toHaveBeenCalledWith([vp8, high, rtx]);
  });
});
