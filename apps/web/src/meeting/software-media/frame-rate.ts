export class FrameRateLimiter {
  private originUs?: number;
  private nextDueUs = 0;
  private readonly intervalUs: number;
  private readonly toleranceUs: number;
  constructor(fps: number) {
    if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('Invalid project frame rate');
    this.intervalUs = 1000000 / fps;
    this.toleranceUs = Math.min(2000, this.intervalUs / 10);
  }
  accept(timestampUs: number): boolean {
    this.originUs ??= timestampUs;
    const elapsedUs = timestampUs - this.originUs;
    if (elapsedUs + this.toleranceUs < this.nextDueUs) return false;
    this.nextDueUs = elapsedUs > this.nextDueUs + this.intervalUs * 2
      ? elapsedUs + this.intervalUs : this.nextDueUs + this.intervalUs;
    return true;
  }
}
