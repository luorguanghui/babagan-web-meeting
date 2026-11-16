import type { ScreenMoqConnectionResponse } from '@meeting/contracts';
import type { ScreenSharePublishOptions } from './screen-share.js';
import type { MoqMediaReading } from './screen-moq-stats.js';

export interface MoqMediaSession {
  close(): void;
  closed: Promise<void>;
  readStats?(): Promise<MoqMediaReading>;
}

type OpenPublisher = (
  connection: ScreenMoqConnectionResponse, stream: MediaStream, options: ScreenSharePublishOptions, signal: AbortSignal
) => Promise<MoqMediaSession>;

interface PublicationApi {
  publish(signal: AbortSignal): Promise<ScreenMoqConnectionResponse>;
  ready(shareId: string, signal: AbortSignal): Promise<void>;
  stop(shareId: string): Promise<void>;
}

const heartbeatMs = 8_000;
const heartbeatRetryMs = 2_000;

export class MoqScreenPublisher {
  private readonly lifetime = new AbortController();
  private shareId?: string;
  private media?: MoqMediaSession;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  private missedHeartbeat = false;

  constructor(
    private readonly api: PublicationApi,
    private readonly open: OpenPublisher,
    private readonly onFailure: () => void
  ) {}

  async start(stream: MediaStream, options: ScreenSharePublishOptions): Promise<void> {
    const signal = this.lifetime.signal;
    try {
      const connection = await this.api.publish(signal);
      if (signal.aborted) {
        await this.api.stop(connection.shareId).catch(() => undefined);
        signal.throwIfAborted();
      }
      this.shareId = connection.shareId;
      const media = await this.open(connection, stream, options, signal);
      if (signal.aborted) {
        media.close();
        signal.throwIfAborted();
      }
      this.media = media;
      await Promise.race([
        this.api.ready(connection.shareId, signal),
        media.closed.then(() => { throw new Error('MoQ media closed during publication.'); })
      ]);
      signal.throwIfAborted();
      void media.closed.then(() => this.fail(), () => this.fail());
      this.scheduleHeartbeat(heartbeatMs);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  getStatsSession(): MoqMediaSession | undefined {
    return this.media;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    clearTimeout(this.heartbeat);
    this.media?.close();
    this.media = undefined;
    const id = this.shareId;
    this.shareId = undefined;
    this.closing = id ? this.api.stop(id).catch(() => undefined) : Promise.resolve();
    return this.closing;
  }

  private scheduleHeartbeat(delay: number): void {
    this.heartbeat = setTimeout(() => { void this.renew(); }, delay);
  }

  private async renew(): Promise<void> {
    const signal = this.lifetime.signal;
    if (signal.aborted || !this.shareId) return;
    try {
      await this.api.ready(this.shareId, signal);
      if (!signal.aborted) {
        this.missedHeartbeat = false;
        this.scheduleHeartbeat(heartbeatMs);
      }
    } catch {
      if (signal.aborted) return;
      if (this.missedHeartbeat) await this.fail();
      else {
        this.missedHeartbeat = true;
        this.scheduleHeartbeat(heartbeatRetryMs);
      }
    }
  }

  private async fail(): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    const cleanup = this.close();
    this.onFailure();
    await cleanup;
  }
}
