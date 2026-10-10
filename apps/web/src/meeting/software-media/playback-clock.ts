export class PlaybackClock {
  private sourceUs?: number;
  private receiverMs = 0;
  reset(): void { this.sourceUs = undefined; }
  anchor(sourceUs: number, receiverMs: number): void {
    if (this.sourceUs !== undefined) return;
    this.sourceUs = sourceUs; this.receiverMs = receiverMs + 100;
  }
  dueAt(sourceUs: number): number {
    if (this.sourceUs === undefined) throw new Error('Playback clock is not anchored');
    return this.receiverMs + (sourceUs - this.sourceUs) / 1000;
  }
  isLate(sourceUs: number, nowMs: number): boolean { return nowMs - this.dueAt(sourceUs) > 200; }
}
