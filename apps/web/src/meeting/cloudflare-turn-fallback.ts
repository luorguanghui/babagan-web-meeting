import type { P2pShareController, P2pShareOptions } from './p2p-share-controller.js';

/** Per-viewer temporary relay; SFU recovery and cleanup cannot block its setup. */
export class CloudflareTurnFallback {
  private controller?: P2pShareController;
  private readonly requested = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly deps: {
    stream: MediaStream; options: P2pShareOptions;
    createController(): P2pShareController;
  }) {}
  request(identity: string): Promise<void> {
    if (this.closed || this.requested.has(identity)) return this.tail;
    this.requested.add(identity);
    const operation = this.tail.then(async () => {
      if (this.closed || !this.requested.has(identity)) return;
      const controller = this.controller ??= this.deps.createController();
      await controller.start(this.deps.stream, { ...this.deps.options, encodingEngine: 'browser' }, [{ identity, nickname: identity }]);
      if (this.closed || !this.requested.has(identity)) controller.handleViewerLeft(identity);
    }).catch(() => { this.requested.delete(identity); });
    this.tail = operation;
    return operation;
  }
  release(identity: string): void {
    this.requested.delete(identity);
    this.controller?.handleViewerLeft(identity);
  }
  async close(): Promise<void> {
    this.closed = true; this.requested.clear();
    await this.controller?.stop();
    await this.tail;
    // A credential request already in flight may finish after the first stop.
    await this.controller?.stop();
  }
}
