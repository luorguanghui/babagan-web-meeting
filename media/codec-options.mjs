export function vp8EncoderOptions({ width, height, fps, bitrate, threads = 1 }) {
  if (![width, height, fps, bitrate, threads].every(Number.isSafeInteger) || width < 16 || height < 16 ||
    (width & 1) || (height & 1) || fps < 1 || fps > 60 || bitrate < 100000 || bitrate > 40000000 || threads < 1 || threads > 4) {
    throw new Error('Invalid realtime VP8 encoding options');
  }
  return {
    time_base: [1, fps],
    ctx: { width, height, pix_fmt: 0, bit_rate: bitrate, framerate_num: fps, framerate_den: 1, gop_size: fps * 2,
      qmin: 4, qmax: 63, rc_min_rate: bitrate, rc_max_rate: bitrate },
    options: { threads: String(threads), deadline: 'realtime', 'cpu-used': '8', 'lag-in-frames': '0',
      'auto-alt-ref': '0', 'dropframe-threshold': '0', bufsize: String(Math.round(bitrate / 2)) }
  };
}

export function opusEncoderOptions(sampleFormat) {
  return { time_base: [1, 48000],
    ctx: { sample_fmt: sampleFormat, sample_rate: 48000, channels: 2, channel_layout: 3, bit_rate: 128000 },
    options: { application: 'lowdelay', frame_duration: '20', vbr: 'off' } };
}
