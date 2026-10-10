import { emptyStats, type ProjectStats } from './encoder.js';
export class StatsSampler {
  private at: number;
  private previous = emptyStats();
  private rates: Partial<ProjectStats> = {};
  constructor(private readonly now = () => performance.now()) { this.at = now(); }
  sample(current: ProjectStats): ProjectStats {
    const now = this.now(), seconds = (now - this.at) / 1000;
    if (seconds >= .5) {
      const delta = (field: 'rawFrames' | 'encodedFrames' | 'decodedFrames' | 'renderedFrames' | 'encodedBytes' | 'sentBytes') => Math.max(0, current[field] - this.previous[field]) / seconds;
      this.rates = { rawFps: delta('rawFrames'), encodedFps: delta('encodedFrames'), decodedFps: delta('decodedFrames'), renderedFps: delta('renderedFrames'),
        encodedBps: delta('encodedBytes') * 8, sentBps: delta('sentBytes') * 8 };
      this.previous = { ...current }; this.at = now;
    }
    return { ...current, ...this.rates };
  }
}
