export interface IdleRefreshFrame<T> { timestamp: number; clone(): T; close(): void; }
export interface NativeIdleRefreshOptions<T> {
  write(frame: T): Promise<unknown>;
  createRefresh(snapshot: T, timestamp: number): T;
  canRefresh(): boolean;
  refreshed?(count: number): void;
  fail(error: unknown): void;
  now?: () => number;
}
/**
 * Explicit 1Hz media keepalive, never an original capture or a 60fps motion claim.
 * Owns one source snapshot beyond the original pacer's queue and at most one refresh in flight.
 * A resumed original waits for that write instead of writing concurrently. Original timestamps
 * are never rewritten; the 100ms projection margin cannot eliminate unusually delayed arrivals.
 */
export class NativeIdleRefresh<T extends IdleRefreshFrame<T>> {
  private snapshot?: T;
  private observedAt = 0;
  private lastRefreshAt = -Infinity;
  private lastOutputTimestamp = -Infinity;
  private timer?: ReturnType<typeof setInterval>;
  private pendingRefresh?: Promise<void>;
  private originalWrites = 0;
  private closed = false;
  private refreshFrames = 0;
  private readonly now: () => number;

  constructor(private readonly options: NativeIdleRefreshOptions<T>) {
    this.now = options.now ?? (() => performance.now());
  }
  observe(frame: T): void {
    if (this.closed) return;
    try {
      const snapshot = frame.clone();
      this.snapshot?.close(); this.snapshot = snapshot; this.observedAt = this.now();
      this.timer ??= setInterval(() => this.tick(), 1000);
    } catch (error) { this.failure(error); }
  }
  async writeOriginal(frame: T): Promise<unknown> {
    const timestamp = frame.timestamp;
    this.originalWrites++;
    try {
      if (this.pendingRefresh) await this.pendingRefresh;
      if (this.closed) throw new DOMException('Native idle refresh stopped.', 'AbortError');
      const result = await this.options.write(frame);
      this.lastOutputTimestamp = Math.max(this.lastOutputTimestamp, timestamp);
      return result;
    } finally { this.originalWrites--; }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); this.timer = undefined;
    this.snapshot?.close(); this.snapshot = undefined;
    // The writer may still own an in-flight refresh; its finally block releases it after settlement.
  }
  stats() { return { refreshFrames: this.refreshFrames }; }
  private tick(): void {
    if (this.closed || !this.snapshot || this.pendingRefresh || this.originalWrites || !this.options.canRefresh()) return;
    const now = this.now();
    if (now - this.observedAt < 1000 || now - this.lastRefreshAt < 1000) return;
    // Stay behind the source's projected clock; originals retain their unmodified capture timestamps.
    const timestamp = Math.floor(this.snapshot.timestamp + Math.max(0, now - this.observedAt - 100) * 1000);
    if (!Number.isSafeInteger(timestamp) || timestamp <= this.lastOutputTimestamp) return;
    let refresh: T;
    try { refresh = this.options.createRefresh(this.snapshot, timestamp); }
    catch (error) { this.failure(error); return; }
    this.lastRefreshAt = now;
    this.pendingRefresh = Promise.resolve().then(async () => {
      if (this.closed) return;
      await this.options.write(refresh);
      this.lastOutputTimestamp = Math.max(this.lastOutputTimestamp, timestamp);
      this.refreshFrames++;
      if (!this.closed) this.options.refreshed?.(this.refreshFrames);
    }).catch(error => this.failure(error)).finally(() => { refresh.close(); this.pendingRefresh = undefined; });
  }
  private failure(error: unknown): void {
    if (this.closed) return;
    this.close(); this.options.fail(error);
  }
}
