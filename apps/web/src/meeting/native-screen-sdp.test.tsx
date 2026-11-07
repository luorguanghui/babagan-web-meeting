import { describe, expect, it } from 'vitest';
import { withNativeScreenBitrateHints } from './native-screen-sdp.js';
describe('native screen bandwidth probe ceiling', () => {
  it('aligns video startup/probe ceilings with the selected cap without changing audio or forcing a minimum', () => {
    const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 stereo=1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 98\r\na=rtpmap:96 AV1/90000\r\na=fmtp:96 profile=0;level-idx=5;tier=0\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=rtpmap:98 H264/90000\r\na=fmtp:98 packetization-mode=1;profile-level-id=64001f\r\n';
    const result = withNativeScreenBitrateHints(sdp, 20_000_000);
    expect(result).toContain('a=fmtp:96 profile=0;level-idx=5;tier=0;x-google-start-bitrate=20000;x-google-max-bitrate=20000\r\n');
    expect(result).toContain('a=fmtp:98 packetization-mode=1;profile-level-id=64001f;x-google-start-bitrate=20000;x-google-max-bitrate=20000\r\n');
    expect(result).toContain('a=fmtp:97 apt=96\r\n'); expect(result).toContain('a=fmtp:111 stereo=1\r\n');
    expect(result).not.toContain('x-google-min-bitrate');
  });
  it('replaces existing hints idempotently when a viewer fair-share cap is lower', () => {
    const sdp='m=video 9 RTP/SAVPF 96\na=rtpmap:96 VP8/90000\na=fmtp:96 x-google-start-bitrate=20000;x-google-max-bitrate=20000;foo=bar\n';
    const result=withNativeScreenBitrateHints(sdp,10_000_000);
    expect(result).toContain('a=fmtp:96 foo=bar;x-google-start-bitrate=10000;x-google-max-bitrate=10000\n');
    expect(withNativeScreenBitrateHints(result,10_000_000)).toBe(result);
  });
  it('adds a missing fmtp only for an advertised video codec and preserves rejected media', () => {
    const sdp='m=video 9 RTP/SAVPF 96 97\r\na=rtpmap:96 VP9/90000\r\na=rtpmap:97 red/90000\r\nm=video 0 RTP/SAVPF 98\r\na=rtpmap:98 H264/90000\r\n';
    const result=withNativeScreenBitrateHints(sdp,8_000_000);
    expect(result).toContain('a=rtpmap:96 VP9/90000\r\na=fmtp:96 x-google-start-bitrate=8000;x-google-max-bitrate=8000\r\n');
    expect(result).not.toContain('a=fmtp:97'); expect(result).not.toContain('a=fmtp:98');
  });
  it.each([NaN,Infinity,-1,0,500,40_000_001])('does not inject invalid or unbounded bitrate %s', cap => {
    const sdp='m=video 9 RTP/SAVPF 96\na=rtpmap:96 VP8/90000\n'; expect(withNativeScreenBitrateHints(sdp,cap)).toBe(sdp);
  });
});
