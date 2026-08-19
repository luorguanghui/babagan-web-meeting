import type { P2pClientMessage, P2pServerMessage } from '@meeting/contracts';
import { parseP2pClientMessage } from '@meeting/contracts';

import type { P2pRoomRegistry, P2pSocket } from './room-registry.js';

/**
 * A connection that sends nothing for this long is considered lost.
 *
 * Must stay well above the browser's background-tab timer throttling: Chrome
 * throttles invisible-tab timers to roughly one firing per minute, so a client
 * whose tab is backgrounded can legitimately stay silent for ~60 s. The old
 * 30 s timeout dropped backgrounded meetings every half minute and broke ICE
 * candidate exchange, forcing viewers onto the TURN relay path.
 */
export const P2P_HEARTBEAT_TIMEOUT_MS = 120_000;
/** Per-connection fixed window, aligned with the general API rate limit (120 msg / 60 s). */
export const P2P_MESSAGE_RATE_LIMIT = { max: 120, windowMs: 60_000 };
/** Application close code for a silent (dead) connection. */
export const P2P_CLOSE_HEARTBEAT_TIMEOUT = 4001;
/** Standard close code for policy violations (rate limit, invalid frames). */
export const P2P_CLOSE_POLICY_VIOLATION = 1008;

/**
 * Forwarded offer/answer/ice/bye envelope: the server injects the sender
 * identity into the client message so the target knows who it is talking to.
 * The contracts P2pServerMessage schema covers only server-originated control
 * messages, so forwarded signaling is passed through as-is with `from` added.
 */
type ForwardedP2pMessage = P2pSignalMessage & { from: string };

/** Client messages that carry a `to` target and are forwarded peer-to-peer. */
type P2pSignalMessage = Extract<P2pClientMessage, { to: string }>;

/**
 * One P2P signaling connection inside a meeting room. Owns the socket-side
 * concerns (heartbeat, per-connection rate limiting, message parsing and
 * forwarding rules); the route layer owns the WS handshake and adapter.
 *
 * Forwarding rules:
 * - `offer`: only the current `share_identity` may send offers, otherwise the
 *   sender gets `P2P_FORBIDDEN` and the message is dropped.
 * - `answer` / `ice` / `bye`: the target must be the current `share_identity`
 *   (viewer → sharer) or the sender must be the sharer. An offline target
 *   gets `P2P_PEER_NOT_FOUND`.
 */
export class P2pSignalingSession {
  private readonly registry: P2pRoomRegistry;
  private readonly slug: string;
  private readonly identity: string;
  private readonly nickname: string;
  private readonly socket: P2pSocket;
  private readonly getShareIdentity: () => string | null;
  private readonly clock: { now(): number };
  private readonly heartbeatTimeoutMs: number;
  private readonly messageRateLimit: { max: number; windowMs: number };

  private heartbeatTimer: NodeJS.Timeout | undefined;
  private rateWindowStartedAt: number;
  private rateWindowCount = 0;
  private closed = false;

  constructor(dependencies: {
    registry: P2pRoomRegistry;
    slug: string;
    identity: string;
    nickname: string;
    socket: P2pSocket;
    /** Current `meetings.share_identity`, read fresh for every message. */
    getShareIdentity: () => string | null;
    clock?: { now(): number };
    heartbeatTimeoutMs?: number;
    messageRateLimit?: { max: number; windowMs: number };
  }) {
    this.registry = dependencies.registry;
    this.slug = dependencies.slug;
    this.identity = dependencies.identity;
    this.nickname = dependencies.nickname;
    this.socket = dependencies.socket;
    this.getShareIdentity = dependencies.getShareIdentity;
    this.clock = dependencies.clock ?? { now: Date.now };
    this.heartbeatTimeoutMs = dependencies.heartbeatTimeoutMs ?? P2P_HEARTBEAT_TIMEOUT_MS;
    this.messageRateLimit = dependencies.messageRateLimit ?? P2P_MESSAGE_RATE_LIMIT;
    this.rateWindowStartedAt = this.clock.now();
  }

  /** Registers the peer in the room, sends `welcome` and announces `peer-joined`. */
  start(): void {
    this.registry.join(this.slug, this.identity, this.nickname, this.socket);
    this.send({
      type: 'welcome',
      peers: this.registry.listPeers(this.slug).filter((peer) => peer.identity !== this.identity)
    });
    this.registry.broadcast(this.slug, {
      type: 'peer-joined',
      peer: { identity: this.identity, nickname: this.nickname }
    }, this.identity);
    this.armHeartbeat();
  }

  /** Processes one raw client frame. Any frame counts as activity. */
  handleMessage(raw: string): void {
    if (this.closed) return;
    this.resetHeartbeat();

    if (!this.consumeRateLimit()) {
      this.sendError('RATE_LIMITED', 'Too many P2P messages; slow down');
      this.close(P2P_CLOSE_POLICY_VIOLATION);
      return;
    }

    let message: P2pClientMessage;
    try {
      message = parseP2pClientMessage(JSON.parse(raw));
    } catch {
      this.sendError('INVALID_MESSAGE', 'Invalid P2P message');
      this.close(P2P_CLOSE_POLICY_VIOLATION);
      return;
    }
    this.dispatch(message);
  }

  /** Disconnects the peer and announces `peer-left`. Idempotent. */
  close(code?: number): void {
    if (this.closed) return;
    this.teardown();
    this.socket.close(code);
  }

  /** Cleans up after the socket closed (from either side). Idempotent. */
  teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer !== undefined) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.registry.leave(this.slug, this.identity, this.socket)) {
      this.registry.broadcast(this.slug, {
        type: 'peer-left',
        peer: { identity: this.identity }
      }, this.identity);
    }
  }

  private dispatch(message: P2pClientMessage): void {
    switch (message.type) {
      case 'hello':
        if (message.participantIdentity !== this.identity) {
          this.sendError('P2P_FORBIDDEN', 'participantIdentity does not match the authenticated session');
          this.close(P2P_CLOSE_POLICY_VIOLATION);
        }
        return;
      case 'ping':
        this.send({ type: 'pong' });
        return;
      case 'offer':
        if (this.getShareIdentity() !== this.identity) {
          this.sendError('P2P_FORBIDDEN', 'Only the current screen sharer may send offers');
          return;
        }
        this.forward(message);
        return;
      case 'media-ready':
        if (this.getShareIdentity() !== message.to || this.identity === message.to) {
          this.sendError('P2P_FORBIDDEN', 'Only a viewer may confirm media to the screen sharer');
          return;
        }
        this.forward(message);
        return;
      case 'retry':
        // A viewer asks the current sharer to re-drive a fresh offer for them.
        if (this.getShareIdentity() !== message.to || this.identity === message.to) {
          this.sendError('P2P_FORBIDDEN', 'Only a viewer may request a P2P retry from the screen sharer');
          return;
        }
        this.forward(message);
        return;
      case 'answer':
      case 'ice':
      case 'bye':
        if (!this.mayTalkTo(message.to)) {
          this.sendError('P2P_FORBIDDEN', 'P2P signaling is limited to the screen sharer');
          return;
        }
        this.forward(message);
        return;
    }
  }

  private mayTalkTo(target: string): boolean {
    const shareIdentity = this.getShareIdentity();
    return shareIdentity === this.identity || shareIdentity === target;
  }

  private forward(message: P2pSignalMessage): void {
    const envelope: ForwardedP2pMessage = { ...message, from: this.identity };
    // Forwarded signaling envelopes are not part of the P2pServerMessage
    // schema (the `from` field is server-injected); they are serialized as-is.
    if (!this.registry.sendTo(this.slug, message.to, envelope as unknown as P2pServerMessage)) {
      this.sendError('P2P_PEER_NOT_FOUND', 'The target peer is not online');
    }
  }

  private consumeRateLimit(): boolean {
    const now = this.clock.now();
    if (now - this.rateWindowStartedAt >= this.messageRateLimit.windowMs) {
      this.rateWindowStartedAt = now;
      this.rateWindowCount = 0;
    }
    this.rateWindowCount += 1;
    return this.rateWindowCount <= this.messageRateLimit.max;
  }

  private armHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this.close(P2P_CLOSE_HEARTBEAT_TIMEOUT);
    }, this.heartbeatTimeoutMs);
    this.heartbeatTimer.unref();
  }

  private resetHeartbeat(): void {
    if (this.closed) return;
    this.armHeartbeat();
  }

  private send(message: P2pServerMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  private sendError(code: string, message: string): void {
    this.send({ type: 'error', code, message });
  }
}
