import { NativeFramePacer, type FrameSchedule } from './native-frame-pacer.js';
import { NativeIdleRefresh } from './native-idle-refresh.js';

interface PacerStats { queuedFrames: number; submittedFrames: number; droppedFrames: number; }
export interface NativePacingStats extends PacerStats {
  receivedFrames: number;
  refreshFrames: number;
  mode: 'worker' | 'local';
  scheduler: 'atomics' | 'timer';
  inFlightFrames: number;
  fallbackReason?: string;
}
export interface NativePacer {
  push(frame: VideoFrame): void;
  close(): void | Promise<void>;
  stats(): NativePacingStats;
}
interface DeliveryOptions { frameRate: 30 | 60; delivered(): void; fail(error: unknown): void; }
export type WorkerRequest = { type: 'init'; frameRate: 30 | 60; writable: WritableStream<VideoFrame>; control?: Int32Array }
  | { type: 'frame'; id: number; frame: VideoFrame } | { type: 'stop' };
type WorkerReply = { type: 'ready' | 'stopped' } | { type: 'error'; message: string }
  | { type: 'refresh'; refreshFrames: number }
  | { type: 'ack'; id: number; stats?: PacerStats } | { type: 'delivered'; stats: PacerStats };

/** Main-side transfer credits bound the worker's message queue as well as its frame queue. */
export class NativeWorkerPacer implements NativePacer {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private initialized = false;
  private closed = false;
  private terminated = false;
  private closing?: Promise<void>;
  private resolveClosed?: () => void;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private readonly initTimer: ReturnType<typeof setTimeout>;
  private readonly pending = new Set<number>();
  private nextId = 0;
  private transferDrops = 0;
  private receivedFrames = 0;
  private refreshFrames = 0;
  private latest: PacerStats = { queuedFrames: 0, submittedFrames: 0, droppedFrames: 0 };

  constructor(private readonly worker: Worker, writable: WritableStream<VideoFrame>,
    private readonly options: DeliveryOptions & { control: Int32Array }) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.initTimer = setTimeout(() => this.failure(new Error('Native frame worker initialization timed out.')), 2000);
    worker.addEventListener('message', this.message);
    worker.addEventListener('error', this.workerError);
    worker.addEventListener('messageerror', this.workerError);
    try { worker.postMessage({ type: 'init', frameRate: options.frameRate, writable, control: options.control }, [writable]); }
    catch (error) { this.failure(error); }
  }
  push(frame: VideoFrame): void {
    if (!this.closed) this.receivedFrames++;
    if (this.closed || !this.initialized || this.pending.size >= 4) { frame.close(); this.transferDrops++; return; }
    const id = ++this.nextId; this.pending.add(id);
    try { this.worker.postMessage({ type: 'frame', id, frame }, [frame]); }
    catch (error) { this.pending.delete(id); frame.close(); this.failure(error); }
  }
  stats(): NativePacingStats {
    return { ...this.latest, droppedFrames: this.latest.droppedFrames + this.transferDrops,
      receivedFrames: this.receivedFrames, refreshFrames: this.refreshFrames,
      inFlightFrames: this.pending.size, mode: 'worker', scheduler: 'atomics' };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; clearTimeout(this.initTimer);
    this.rejectReady(new DOMException('Native frame worker stopped.', 'AbortError'));
    this.closing = new Promise(resolve => { this.resolveClosed = resolve; });
    Atomics.store(this.options.control, 0, 1); Atomics.notify(this.options.control, 0);
    this.stopTimer = setTimeout(() => this.terminate(), 250);
    try { this.worker.postMessage({ type: 'stop' }); } catch { this.terminate(); }
    return this.closing;
  }
  private message = (event: MessageEvent<WorkerReply>): void => {
    const data = event.data;
    if (data.type === 'stopped') {
      if (!this.closed) this.failure(new Error('Native frame worker stopped unexpectedly.'));
      this.terminate(); return;
    }
    if (this.closed) return;
    if (data.type === 'ready') { clearTimeout(this.initTimer); this.initialized = true; this.resolveReady(); }
    else if (data.type === 'error') this.failure(new Error(data.message));
    else if (data.type === 'ack') { this.pending.delete(data.id); if (data.stats) this.latest = data.stats; }
    else if (data.type === 'delivered') { this.latest = data.stats; this.options.delivered(); }
    else if (data.type === 'refresh') this.refreshFrames = data.refreshFrames;
  };
  private workerError = (): void => this.failure(new Error('Native frame worker failed.'));
  private failure(error: unknown): void {
    if (this.closed) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.rejectReady(failure);
    if (this.initialized) this.options.fail(failure);
    void this.close();
  }
  private terminate(): void {
    if (this.terminated) return;
    this.terminated = true; clearTimeout(this.initTimer); clearTimeout(this.stopTimer);
    this.worker.removeEventListener('message', this.message);
    this.worker.removeEventListener('error', this.workerError);
    this.worker.removeEventListener('messageerror', this.workerError);
    this.worker.terminate(); this.pending.clear(); this.resolveClosed?.();
  }
}

export function localNativePacer(writer: { write(frame: VideoFrame): Promise<unknown>; close(): Promise<unknown> },
  options: DeliveryOptions, fallbackReason: string): NativePacer {
  let closing: Promise<void> | undefined;
  let receivedFrames = 0;
  const idle: NativeIdleRefresh<VideoFrame> = new NativeIdleRefresh<VideoFrame>({ write: frame => writer.write(frame),
    createRefresh: (snapshot, timestamp) => new VideoFrame(snapshot, { timestamp }),
    canRefresh: () => pacer.stats().queuedFrames === 0, fail: error => failure(error) });
  const pacer: NativeFramePacer<VideoFrame> = new NativeFramePacer<VideoFrame>({ ...options, deliver: frame => idle.writeOriginal(frame), fail: error => failure(error) });
  const close = () => closing ??= (() => { idle.close(); pacer.close(); return writer.close().then(() => undefined, () => undefined); })();
  const failure = (error: unknown) => { if (!closing) { void close(); options.fail(error); } };
  return { push: frame => { if (!closing) { receivedFrames++; idle.observe(frame); } pacer.push(frame); }, close,
    stats: () => ({ ...pacer.stats(), ...idle.stats(), receivedFrames, mode: 'local', scheduler: 'timer', inFlightFrames: 0, fallbackReason }) };
}

/** Only used inside the dedicated worker: no cadence callback returns to the renderer. */
export function atomicFrameSchedule(control: Int32Array, now = () => performance.now()): FrameSchedule {
  return (callback, delay) => {
    const deadline = now() + delay;
    const timer = setTimeout(() => {
      let remaining = deadline - now();
      while (remaining > 0 && Atomics.load(control, 0) === 0) {
        Atomics.wait(control, 0, 0, remaining); remaining = deadline - now();
      }
      if (Atomics.load(control, 0) === 0) callback();
    }, 0);
    return () => clearTimeout(timer);
  };
}

/** The worker owns both the pacing queue and the transferred generator writer. */
export class NativeFrameWorkerRuntime {
  private pacer?: NativeFramePacer<VideoFrame>;
  private idle?: NativeIdleRefresh<VideoFrame>;
  private writer?: WritableStreamDefaultWriter<VideoFrame>;
  private stopped = false;
  private closing?: Promise<void>;
  constructor(private readonly post: (message: WorkerReply) => void,
    private readonly timing: { now?: () => number; schedule?: FrameSchedule } = {}) {}
  handle(message: WorkerRequest): void {
    if (message.type === 'stop') { void this.close(); return; }
    if (message.type === 'frame') {
      if (this.stopped || !this.pacer) message.frame.close();
      else { this.idle!.observe(message.frame); this.pacer.push(message.frame); }
      this.post({ type: 'ack', id: message.id, stats: this.pacer?.stats() }); return;
    }
    try {
      if (this.stopped || this.writer) throw new Error('Native frame worker cannot initialize twice.');
      this.writer = message.writable.getWriter();
      this.idle = new NativeIdleRefresh<VideoFrame>({ now: this.timing.now,
        write: frame => this.writer!.write(frame),
        createRefresh: (snapshot, timestamp) => new VideoFrame(snapshot, { timestamp }),
        canRefresh: () => this.pacer?.stats().queuedFrames === 0,
        refreshed: refreshFrames => { if (!this.stopped) this.post({ type: 'refresh', refreshFrames }); },
        fail: error => this.failure(error) });
      this.pacer = new NativeFramePacer<VideoFrame>({ frameRate: message.frameRate,
        ...this.timing, schedule: this.timing.schedule ?? (message.control ? atomicFrameSchedule(message.control) : undefined),
        deliver: frame => this.idle!.writeOriginal(frame),
        delivered: () => { if (!this.stopped) this.post({ type: 'delivered', stats: this.pacer!.stats() }); },
        fail: error => this.failure(error) });
      this.post({ type: 'ready' });
    } catch (error) { this.failure(error); }
  }
  private failure(error: unknown): void {
    if (this.stopped) return;
    this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    void this.close();
  }
  private close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; this.idle?.close(); this.pacer?.close();
    this.closing = Promise.resolve().then(() => this.writer?.close()).catch(() => undefined)
      .then(() => { this.post({ type: 'stopped' }); });
    return this.closing;
  }
}
