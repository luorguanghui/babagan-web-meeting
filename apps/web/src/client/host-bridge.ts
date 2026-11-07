import type { ClientHostEvent, ClientHostInfo, ClientHostRequest } from '@meeting/contracts';

export class ClientHostError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ClientHostError'; }
}
export interface HostRequestOptions { timeoutMs?: number; signal?: AbortSignal; }
export interface ClientHost {
  readonly platform: ClientHostInfo['platform'];
  request<T = unknown>(method: ClientHostRequest['method'], params?: Record<string, unknown>, options?: HostRequestOptions): Promise<T>;
  subscribe(listener: (event: ClientHostEvent) => void): () => void;
}
export interface ClientHostTransport {
  platform: ClientHostInfo['platform'];
  send(request: ClientHostRequest): void;
  listen(listener: (message: unknown) => void): () => void;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Correlation and timeouts belong here; capture-session ownership belongs to the capture adapter. */
export class NativeClientBridge implements ClientHost {
  readonly platform: ClientHostInfo['platform'];
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; detach: () => void }>();
  private readonly listeners = new Set<(event: ClientHostEvent) => void>();
  private readonly unlisten: () => void;
  private disposed = false;
  constructor(private readonly transport: ClientHostTransport) {
    this.platform = transport.platform;
    this.unlisten = transport.listen(value => this.receive(value));
  }
  request<T = unknown>(method: ClientHostRequest['method'], params?: Record<string, unknown>, options: HostRequestOptions = {}): Promise<T> {
    if (this.disposed) return Promise.reject(new ClientHostError('unavailable', 'The client connection is closed.'));
    if (options.signal?.aborted) return Promise.reject(new DOMException('Client request cancelled.', 'AbortError'));
    return new Promise<T>((resolve, reject) => {
      const id = crypto.randomUUID();
      const finish = (error: Error) => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id); item.detach(); item.reject(error);
      };
      const abort = () => finish(new DOMException('Client request cancelled.', 'AbortError'));
      const timer = setTimeout(() => finish(new ClientHostError('timeout', `${method} timed out.`)), options.timeoutMs ?? 15_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, detach: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); } });
      options.signal?.addEventListener('abort', abort, { once: true });
      try { this.transport.send({ v: 1, id, method, ...(params ? { params } : {}) }); }
      catch { finish(new ClientHostError('unavailable', 'The native client did not accept the request.')); }
    });
  }
  subscribe(listener: (event: ClientHostEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.unlisten(); this.listeners.clear();
    for (const item of this.pending.values()) { item.detach(); item.reject(new ClientHostError('unavailable', 'The client connection is closed.')); }
    this.pending.clear();
  }
  private receive(raw: unknown): void {
    if (this.disposed) return;
    let value = raw;
    if (typeof value === 'string') {
      if (value.length > 262_144) return;
      try { value = JSON.parse(value); } catch { return; }
    }
    if (!record(value) || value.v !== 1) return;
    if (typeof value.id === 'string') {
      const item = this.pending.get(value.id);
      if (!item || typeof value.ok !== 'boolean') return;
      if (!value.ok && (!record(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string')) return;
      this.pending.delete(value.id); item.detach();
      if (value.ok) item.resolve(value.result);
      else { const error = value.error as { code: string; message: string }; item.reject(new ClientHostError(error.code, error.message)); }
      return;
    }
    if (typeof value.event !== 'string' || !['capture.signal', 'capture.ended', 'capture.resized', 'update.state', 'pictureInPicture.state', 'audio.routesChanged'].includes(value.event)) return;
    for (const listener of this.listeners) { try { listener(value as ClientHostEvent); } catch { /* One consumer cannot prevent another from receiving an event. */ } }
  }
}

interface WebViewTransport { postMessage(message: unknown): void; addEventListener(type: 'message', listener: (event: MessageEvent) => void): void; removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void; }
interface AndroidTransport { postMessage(message: string): void; onmessage?: ((event: { data: string }) => void) | null; }
export type ClientHostWindow = Window & { chrome?: { webview?: WebViewTransport }; BabaganAndroid?: AndroidTransport };

export function detectClientTransport(target: ClientHostWindow): ClientHostTransport | undefined {
  const android = target.BabaganAndroid;
  if (android && typeof android.postMessage === 'function') return {
    platform: 'android', send: request => android.postMessage(JSON.stringify(request)),
    listen: listener => {
      const previous = android.onmessage;
      const receive = (event: { data: string }) => listener(event.data);
      android.onmessage = receive;
      return () => { if (android.onmessage === receive) android.onmessage = previous; };
    },
  };
  const webview = target.chrome?.webview;
  if (webview && typeof webview.postMessage === 'function' && typeof webview.addEventListener === 'function') return {
    platform: 'windows', send: request => webview.postMessage(request),
    listen: listener => { const receive = (event: MessageEvent) => listener(event.data); webview.addEventListener('message', receive); return () => webview.removeEventListener('message', receive); },
  };
  return undefined;
}

export function validClientInfo(value: unknown, platform: ClientHostInfo['platform']): value is ClientHostInfo {
  return record(value) && value.protocol === 1 && value.platform === platform
    && typeof value.appVersion === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.appVersion)
    && typeof value.screenCapture === 'boolean' && (value.systemAudio === undefined || typeof value.systemAudio === 'boolean')
    && (value.maxScreenFrameRate === undefined || value.maxScreenFrameRate === 30 || value.maxScreenFrameRate === 60)
    && (value.pictureInPicture === undefined || typeof value.pictureInPicture === 'boolean')
    && (value.audioRouting === undefined || typeof value.audioRouting === 'boolean');
}
