import type { CloudflareSfuPublication } from '@meeting/contracts';
import { ApiRequestError } from '../api/client.js';
import type { CloudflareScreenSession } from './cloudflare-sfu.js';
import type { ScreenSharePublishOptions } from './screen-share.js';

type Session = Pick<CloudflareScreenSession, 'publish' | 'subscribe' | 'close' | 'getStatsReport'>;
export function isTerminalCloudflareError(error: unknown): boolean {
  return error instanceof ApiRequestError && [401, 403, 404, 410].includes(error.status);
}

/** One allocation at a time; recovery never stops the original screen capture. */
export class CloudflareScreenRecovery {
  private session?: Session;
  private operation?: (session: Session) => Promise<void>;
  private publisher = false;
  private stopped = false;
  private generation = 0;
  private failures = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private videoTimer?: ReturnType<typeof setTimeout>;
  private tail: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;

  constructor(private readonly deps: {
    createSession(onStream: (stream: MediaStream) => void, onError: (error: unknown) => void): Session;
    onStream?(stream: MediaStream): void;
    onError?(error: unknown): void;
    onRecovering?(recovering: boolean): void;
  }) {}

  publish(stream: MediaStream, options: ScreenSharePublishOptions): Promise<void> {
    this.publisher = true;
    return this.start(s => s.publish(stream, options));
  }
  subscribe(publication: CloudflareSfuPublication): Promise<void> {
    return this.start(s => s.subscribe(publication));
  }
  private start(operation: (session: Session) => Promise<void>): Promise<void> {
    if (this.operation || this.stopped) return Promise.reject(new Error('Screen recovery already started or stopped.'));
    this.operation = operation;
    const starting = this.attempt(true);
    this.tail = starting.catch(() => undefined);
    return starting;
  }
  retry(): void {
    if (this.stopped || !this.operation) return;
    this.fail(this.generation, new Error('Reconnecting Cloudflare SFU.'));
  }
  getStatsReport(): Promise<RTCStatsReport | undefined> {
    return this.session?.getStatsReport() ?? Promise.resolve(undefined);
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    this.generation++;
    clearTimeout(this.retryTimer); clearTimeout(this.videoTimer);
    const session = this.session; this.session = undefined;
    this.closePromise = Promise.all([this.tail, session?.close()]).then(() => undefined);
    return this.closePromise;
  }
  private async attempt(initial = false): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    let videoReceived = false;
    const session = this.deps.createSession(stream => {
      if (!this.current(generation)) return;
      videoReceived = true;
      clearTimeout(this.videoTimer);
      this.failures = 0;
      this.deps.onStream?.(stream);
      this.deps.onRecovering?.(false);
    }, error => this.fail(generation, error));
    this.session = session;
    try {
      await this.operation!(session);
      if (!this.current(generation)) return;
      if (this.publisher) {
        this.failures = 0;
        this.deps.onRecovering?.(false);
      } else if (!videoReceived) {
        this.videoTimer = setTimeout(() => this.fail(generation, new Error('Cloudflare SFU did not deliver screen video.')), 12000);
      }
    } catch (error) {
      this.fail(generation, error);
      if (initial && !this.stopped && isTerminalCloudflareError(error)) throw error;
    }
  }
  private current(generation: number): boolean { return !this.stopped && this.generation === generation; }
  private fail(generation: number, error: unknown): void {
    if (!this.current(generation)) return;
    this.generation++; // Invalidate duplicate errors and late stream callbacks immediately.
    clearTimeout(this.videoTimer);
    // Authentication/authorization errors require a fresh join or share grant.
    if (isTerminalCloudflareError(error)) {
      this.deps.onRecovering?.(false);
      this.deps.onError?.(error);
      return;
    }
    this.deps.onRecovering?.(true);
    this.deps.onError?.(error);
    const delay = Math.min(10000, 500 * 2 ** Math.min(this.failures++, 5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      const previous = this.session; this.session = undefined;
      // Close can wait for an outstanding allocation. TURN runs independently.
      this.tail = Promise.all([this.tail, previous?.close()]).then(() => this.attempt());
    }, delay);
  }
}
