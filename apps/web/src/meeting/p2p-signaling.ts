import type { P2pClientMessage } from '@meeting/contracts';

/** Interval at which the client pings the server to keep the connection alive. */
export const P2P_HEARTBEAT_INTERVAL_MS = 25_000;
/** First reconnect delay; doubles on every consecutive failure. */
export const P2P_RECONNECT_BACKOFF_BASE_MS = 1_000;
/** Ceiling for the exponential reconnect backoff. */
export const P2P_RECONNECT_BACKOFF_MAX_MS = 30_000;
/**
 * Consecutive failed connections before the client gives up. Chrome surfaces
 * an HTTP 401 handshake rejection as a generic 1006 close, so the client
 * cannot tell "session revoked" from a transient network drop; five straight
 * failures mean the session is gone (expired or revoked), and retrying
 * forever would only fan a 401 storm against the server. A `welcome` resets
 * the counter.
 */
export const P2P_MAX_CONSECUTIVE_RECONNECTS = 5;

export interface Peer {
  identity: string;
  nickname: string;
}

export interface P2pSignalingEvents {
  onWelcome(peers: Peer[]): void;
  onPeerJoined(peer: Peer): void;
  onPeerLeft(peer: { identity: string }): void;
  onOffer(from: string, sdp: string): void;
  onAnswer(from: string, sdp: string): void;
  onIce(from: string, candidate: string | null): void;
  onMediaReady(from: string): void;
  /** A viewer asked the sharer to re-drive a fresh offer for them. */
  onRetry(from: string): void;
  onBye(from: string, reason?: string): void;
  onShareGone(): void;
  onError(code: string): void;
}

/** Minimal WebSocket surface the signaling client needs (real or fake). */
export interface P2pWebSocket {
  send(data: string): void;
  close(code?: number): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface P2pSignalingDependencies {
  /** Socket factory; defaults to the browser `WebSocket` (same-origin cookies are sent automatically). */
  createWebSocket?: (url: string) => P2pWebSocket;
  /** Page origin; defaults to `window.location`. */
  location?: { protocol: string; host: string };
  heartbeatIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxReconnectAttempts?: number;
  /**
   * Registers a `visibilitychange` listener (defaults to `document`). The
   * client pings on every visibility change so a tab that comes back from the
   * background immediately refreshes the server-side heartbeat timer instead
   * of waiting for the throttled interval.
   */
  addVisibilityListener?: (listener: () => void) => () => void;
}

export function buildP2pSignalingUrl(slug: string, pageLocation: { protocol: string; host: string }): string {
  const scheme = pageLocation.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${pageLocation.host}/api/v1/meetings/${encodeURIComponent(slug)}/p2p`;
}

/**
 * Client for the meeting P2P signaling WebSocket.
 *
 * The server forwards offer/answer/ice/bye as envelopes with an injected
 * `from` field (`{...msg, from}`); every incoming frame has `from` stripped
 * before it is dispatched to the matching event callback. `welcome` carries
 * the full peer roster and is delivered on every (re)connect, so a reconnected
 * client restores its view of the room without replaying individual events.
 */
export class P2pSignalingClient {
  private readonly createWebSocket: (url: string) => P2pWebSocket;
  private readonly pageLocation: { protocol: string; host: string };
  private readonly heartbeatIntervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly removeVisibilityListener: () => void;

  private socket?: P2pWebSocket;
  private closed = false;
  private connectPromise?: Promise<void>;
  private resolveConnect?: () => void;
  private rejectConnect?: (reason: Error) => void;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Consecutive failed connections since the last `welcome`; reset on success. */
  private backoff = 0;

  constructor(
    private readonly slug: string,
    private readonly identity: string,
    private readonly events: P2pSignalingEvents,
    dependencies: P2pSignalingDependencies = {}
  ) {
    this.createWebSocket = dependencies.createWebSocket
      ?? ((url) => new WebSocket(url) as unknown as P2pWebSocket);
    this.pageLocation = dependencies.location ?? window.location;
    this.heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? P2P_HEARTBEAT_INTERVAL_MS;
    this.backoffBaseMs = dependencies.backoffBaseMs ?? P2P_RECONNECT_BACKOFF_BASE_MS;
    this.backoffMaxMs = dependencies.backoffMaxMs ?? P2P_RECONNECT_BACKOFF_MAX_MS;
    this.maxReconnectAttempts = dependencies.maxReconnectAttempts ?? P2P_MAX_CONSECUTIVE_RECONNECTS;
    const addVisibilityListener = dependencies.addVisibilityListener ?? ((listener: () => void) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    });
    // A backgrounded tab throttles the 25 s heartbeat to ~60 s; pinging on
    // visibility changes keeps the server-side timer fresh when the tab
    // returns (and again right before it is throttled).
    this.removeVisibilityListener = addVisibilityListener(() => this.send({ type: 'ping' }));
  }

  /**
   * Opens the first connection and resolves once the server has welcomed the
   * client. Subsequent reconnects happen automatically; this method only
   * resolves the initial handshake.
   */
  connect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.socket) return this.connectPromise ?? Promise.resolve();
    this.cancelReconnect();
    const promise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.connectPromise = promise;
    try {
      this.openSocket();
    } catch (error) {
      this.rejectPendingConnect(error instanceof Error ? error : new Error('Failed to open the P2P signaling socket'));
      this.scheduleReconnect();
    }
    return promise;
  }

  sendOffer(to: string, sdp: string): void {
    this.send({ type: 'offer', to, sdp });
  }

  sendAnswer(to: string, sdp: string): void {
    this.send({ type: 'answer', to, sdp });
  }

  sendIce(to: string, candidate: string | null): void {
    this.send({ type: 'ice', to, candidate });
  }

  sendMediaReady(to: string): void {
    this.send({ type: 'media-ready', to });
  }

  sendRetry(to: string): void {
    this.send({ type: 'retry', to });
  }

  sendBye(to: string, reason?: string): void {
    this.send(reason === undefined ? { type: 'bye', to } : { type: 'bye', to, reason });
  }

  /** Terminates the client: closes the socket and stops any reconnect attempt. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.removeVisibilityListener();
    this.cancelReconnect();
    this.disarmHeartbeat();
    if (this.socket) {
      const socket = this.socket;
      this.socket = undefined;
      socket.close(1000);
    }
    this.rejectPendingConnect(new Error('P2P signaling client closed'));
  }

  private openSocket(): void {
    const socket = this.createWebSocket(buildP2pSignalingUrl(this.slug, this.pageLocation));
    this.socket = socket;
    socket.onopen = () => {
      if (!this.ownsSocket(socket)) return;
      this.send({ type: 'hello', participantIdentity: this.identity });
      this.armHeartbeat();
    };
    socket.onmessage = (event) => {
      if (!this.ownsSocket(socket)) return;
      this.handleMessage(event.data);
    };
    socket.onerror = () => {
      // The close event always follows an error; reconnecting is handled there.
    };
    socket.onclose = () => {
      if (!this.ownsSocket(socket)) return;
      this.socket = undefined;
      this.disarmHeartbeat();
      this.rejectPendingConnect(new Error('P2P signaling connection failed before the server welcome'));
      if (this.closed) return;
      this.scheduleReconnect();
    };
  }

  private ownsSocket(socket: P2pWebSocket): boolean {
    return this.socket === socket;
  }

  private handleMessage(data: unknown): void {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof raw !== 'object' || raw === null) return;
    const message = raw as Record<string, unknown>;
    // Forwarded offer/answer/ice/bye arrive as `{...msg, from}` envelopes.
    const from = typeof message.from === 'string' ? message.from : undefined;
    switch (message.type) {
      case 'welcome': {
        const peers = message.peers;
        this.backoff = 0;
        this.events.onWelcome(Array.isArray(peers) ? peers.filter(isPeer) : []);
        this.resolvePendingConnect();
        break;
      }
      case 'peer-joined': {
        const peer = message.peer;
        if (isPeer(peer)) this.events.onPeerJoined(peer);
        break;
      }
      case 'peer-left': {
        const peer = message.peer;
        if (isIdentity(peer)) this.events.onPeerLeft({ identity: peer.identity });
        break;
      }
      case 'pong':
        break;
      case 'share-gone':
        this.events.onShareGone();
        break;
      case 'error':
        if (typeof message.code === 'string') this.events.onError(message.code);
        break;
      case 'offer':
        if (from !== undefined && typeof message.sdp === 'string') this.events.onOffer(from, message.sdp);
        break;
      case 'answer':
        if (from !== undefined && typeof message.sdp === 'string') this.events.onAnswer(from, message.sdp);
        break;
      case 'ice': {
        const candidate = message.candidate;
        if (from !== undefined && (typeof candidate === 'string' || candidate === null)) {
          this.events.onIce(from, candidate);
        }
        break;
      }
      case 'media-ready':
        if (from !== undefined) this.events.onMediaReady(from);
        break;
      case 'retry':
        if (from !== undefined) this.events.onRetry(from);
        break;
      case 'bye':
        if (from !== undefined) {
          this.events.onBye(from, typeof message.reason === 'string' ? message.reason : undefined);
        }
        break;
      default:
        break;
    }
  }

  private send(message: P2pClientMessage): void {
    if (this.closed || !this.socket) return;
    this.socket.send(JSON.stringify(message));
  }

  private armHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      this.send({ type: 'ping' });
    }, this.heartbeatIntervalMs);
  }

  private disarmHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== undefined) return;
    // `backoff` counts consecutive failures since the last welcome; beyond the
    // cap the session is effectively gone and retrying would only hammer the
    // server with 401s forever.
    if (this.backoff >= this.maxReconnectAttempts) return;
    const delay = Math.min(this.backoffBaseMs * (2 ** this.backoff), this.backoffMaxMs);
    this.backoff += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed) return;
      this.openSocket();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private resolvePendingConnect(): void {
    if (this.resolveConnect === undefined) return;
    const resolve = this.resolveConnect;
    this.resolveConnect = undefined;
    this.rejectConnect = undefined;
    resolve();
  }

  private rejectPendingConnect(reason: Error): void {
    if (this.rejectConnect === undefined) return;
    const reject = this.rejectConnect;
    this.resolveConnect = undefined;
    this.rejectConnect = undefined;
    reject(reason);
  }
}

function isPeer(value: unknown): value is Peer {
  if (typeof value !== 'object' || value === null) return false;
  const peer = value as Record<string, unknown>;
  return typeof peer.identity === 'string' && typeof peer.nickname === 'string';
}

function isIdentity(value: unknown): value is { identity: string } {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>).identity === 'string';
}

export function createP2pSignalingClient(
  slug: string,
  identity: string,
  events: P2pSignalingEvents,
  dependencies?: P2pSignalingDependencies
): P2pSignalingClient {
  return new P2pSignalingClient(slug, identity, events, dependencies);
}
