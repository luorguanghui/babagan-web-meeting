export function vp8EncoderOptions(options: { width: number; height: number; fps: number; bitrate: number; threads?: number }): {
  time_base: number[];
  ctx: Record<string, number>;
  options: Record<string, string>;
};
export function opusEncoderOptions(sampleFormat: number): { time_base: number[]; ctx: Record<string, number>; options: Record<string, string> };
