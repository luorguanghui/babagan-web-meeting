interface PacedFrame { timestamp: number; close(): void; }
export type FrameSchedule = (callback: () => void, delay: number) => () => void;

/** Delivers each captured frame at most once; never fabricates a refresh frame. */
export class NativeFramePacer<T extends PacedFrame> {
  private readonly queue: T[] = [];
  private cancelTimer?: () => void;
  private busy = false;
  private closed = false;
  private anchorTimestamp?: number;
  private anchorTime = 0;
  private lastDeliveryTime = -Infinity;
  private submittedFrames = 0;
  private droppedFrames = 0;
  private readonly interval: number;
  private readonly now: () => number;
  constructor(private readonly options: {
    frameRate: 30 | 60;
    deliver(frame: T): void | Promise<unknown>;
    delivered?(): void;
    fail(error: unknown): void;
    now?: () => number;
    schedule?: FrameSchedule;
  }) {
    this.interval = 1000 / options.frameRate;
    this.now = options.now ?? (() => performance.now());
  }
  push(frame: T): void {
    if (this.closed) { frame.close(); return; }
    const now = this.now();
    if (this.anchorTimestamp === undefined || (!this.queue.length && Math.abs(this.due(frame) - now) > 250)) {
      this.anchorTimestamp = frame.timestamp; this.anchorTime = now + 40;
    }
    this.queue.push(frame);
    if (this.queue.length > 4) {
      this.queue.shift()!.close(); this.droppedFrames++;
      // Do not chase an ever-later head deadline when arrivals keep the queue
      // full after a renderer stall. Rebase delivery, never the capture timestamp.
      this.anchorTimestamp = this.queue[0].timestamp;
      this.anchorTime = Math.max(now, this.lastDeliveryTime + this.interval * 0.8);
      this.cancelTimer?.(); this.cancelTimer = undefined;
    }
    this.arm();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.cancelTimer?.(); this.cancelTimer = undefined;
    for (const frame of this.queue.splice(0)) frame.close();
  }
  stats() { return { queuedFrames: this.queue.length, submittedFrames: this.submittedFrames, droppedFrames: this.droppedFrames }; }
  private due(frame: T): number { return this.anchorTime + (frame.timestamp - this.anchorTimestamp!) / 1000; }
  private arm(): void {
    if (this.closed || this.busy || this.cancelTimer !== undefined || !this.queue.length) return;
    const run = () => { this.cancelTimer = undefined; void this.emit(); };
    const delay = Math.max(0, this.due(this.queue[0]) - this.now());
    if (this.options.schedule) this.cancelTimer = this.options.schedule(run, delay);
    else { const timer = setTimeout(run, Math.ceil(delay)); this.cancelTimer = () => clearTimeout(timer); }
  }
  private async emit(): Promise<void> {
    if (this.closed || this.busy || !this.queue.length) return;
    const now = this.now();
    // After a blocked task, discard stale originals instead of bursting old frames.
    while (this.queue.length > 1 && this.due(this.queue[1]) < now - this.interval / 2) {
      this.queue.shift()!.close(); this.droppedFrames++;
    }
    const frame = this.queue.shift()!;
    // Scheduler lateness is not source clock drift. Moving the anchor on every
    // late task accumulates that delay and eventually drops otherwise timely
    // 60fps frames. Source gaps and bounded-queue overflow rebase separately.
    this.busy = true; this.lastDeliveryTime = now; let submitted = false;
    try {
      await this.options.deliver(frame); this.submittedFrames++; submitted = true;
    } catch (error) {
      this.close(); this.options.fail(error);
    } finally {
      frame.close(); this.busy = false;
      if (submitted && !this.closed) this.options.delivered?.();
      this.arm();
    }
  }
}
