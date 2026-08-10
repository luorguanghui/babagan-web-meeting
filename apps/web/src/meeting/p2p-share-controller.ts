import { P2P_ICE_DISCONNECT_TIMEOUT_MS, P2P_ICE_NEGOTIATION_TIMEOUT_MS, type P2pScreenBitrate } from '@meeting/contracts';
import { Type } from '@sinclair/typebox';

import { apiRequest } from '../api/client.js';
import type { Peer } from './p2p-signaling.js';

export type ViewerSessionState = 'negotiating' | 'p2p' | 'livekit-fallback' | 'closed';

/**
 * Sharer-side P2P session controller for the screen share: one `RTCPeerConnection`
 * per viewer (star topology), with a per-viewer fallback state machine
 * (`negotiating -> p2p`, terminal `livekit-fallback` / `closed`).
 *
 * The controller never publishes media itself: a `livekit-fallback` state is
 * surfaced via `onViewerFallback` and the subscription, and the caller (Task 7)
 * decides whether to publish a LiveKit screen track for those viewers.
 */
export interface P2pShareController {
  start(stream: MediaStream, bitrate: P2pScreenBitrate, viewers: Peer[]): Promise<void>;
  handleAnswer(from: string, sdp: string): Promise<void>;
  handleIce(from: string, candidate: string | null): Promise<void>;
  handleViewerLeft(identity: string): void;
  stop(): Promise<void>;   // 关闭全部 PC，广播 bye
  getViewerStates(): ReadonlyMap<string, ViewerSessionState>;
  subscribe(listener: (states: ReadonlyMap<string, ViewerSessionState>) => void): () => void;
}

/**
 * Minimal signaling surface the controller needs. `P2pSignalingClient` satisfies
 * it structurally, so tests can inject a fake without a WebSocket.
 */
export interface P2pShareSignaling {
  sendOffer(to: string, sdp: string): void;
  sendIce(to: string, candidate: string | null): void;
  sendBye(to: string, reason?: string): void;
}

export interface P2pShareControllerDependencies {
  slug: string;
  signaling: P2pShareSignaling;
  /** PC factory; defaults to `window.RTCPeerConnection` with the fetched ICE servers. */
  createPeerConnection?: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  /** ICE credentials; defaults to `GET /api/v1/meetings/:slug/ice-servers`. */
  fetchIceServers?: () => Promise<RTCIceServer[]>;
  /** Fired once per viewer that moves to `livekit-fallback` (the caller publishes the LiveKit screen track). */
  onViewerFallback?: (identity: string) => void;
  /** Fired when every tracked viewer has left (`closed`); the caller may then stop the whole share. */
  onAllViewersClosed?: () => void;
}

export const IceServersResponseSchema = Type.Object({
  iceServers: Type.Array(Type.Object({
    urls: Type.Array(Type.String()),
    username: Type.Optional(Type.String()),
    credential: Type.Optional(Type.String())
  }))
});

/**
 * Serializes an ICE candidate for the signaling wire. The contracts schema only
 * allows `string | null`, so candidates travel as JSON-encoded `RTCIceCandidateInit`
 * (preserves `sdpMid`/`sdpMLineIndex`, which matters with two m-lines on one PC).
 * Task 6 should reuse this helper so both sides agree on the wire format.
 */
export function serializeIceCandidate(candidate: RTCIceCandidate): string {
  return JSON.stringify(candidate.toJSON());
}

/** Inverse of {@link serializeIceCandidate}; tolerates bare candidate strings too. */
export function deserializeIceCandidate(raw: string): RTCIceCandidateInit {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { candidate?: unknown }).candidate === 'string') {
      return parsed as RTCIceCandidateInit;
    }
  } catch {
    // Not JSON; fall through to the bare-candidate form.
  }
  return { candidate: raw };
}

interface ViewerSession {
  identity: string;
  pc: RTCPeerConnection;
  videoSender?: RTCRtpSender;
  bitrate: P2pScreenBitrate;
  state: ViewerSessionState;
  queuedCandidates: Array<RTCIceCandidateInit | undefined>;
  pendingOffer: boolean;
  offerSent: boolean;
  pcClosed: boolean;
  negotiationTimer?: ReturnType<typeof setTimeout>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
}

class P2pShareControllerImpl implements P2pShareController {
  private readonly createPeerConnection: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  private readonly fetchIceServers: () => Promise<RTCIceServer[]>;
  private readonly sessions = new Map<string, ViewerSession>();
  private readonly listeners = new Set<(states: ReadonlyMap<string, ViewerSessionState>) => void>();
  private iceServers?: RTCIceServer[];

  constructor(private readonly deps: P2pShareControllerDependencies) {
    this.createPeerConnection = deps.createPeerConnection
      ?? ((servers) => new RTCPeerConnection({ iceServers: servers }));
    this.fetchIceServers = deps.fetchIceServers ?? defaultFetchIceServers(deps.slug);
  }

  async start(stream: MediaStream, bitrate: P2pScreenBitrate, viewers: Peer[]): Promise<void> {
    const iceServers = await this.resolveIceServers();
    const establishes: Promise<void>[] = [];
    for (const viewer of viewers) {
      const existing = this.sessions.get(viewer.identity);
      // A viewer that left and rejoined starts a fresh session; p2p/fallback sessions keep running.
      if (existing && existing.state !== 'closed') continue;
      if (existing) this.closeSession(existing);
      const session = this.createSession(viewer.identity, stream, bitrate, iceServers);
      establishes.push(this.establishSession(session));
    }
    this.emit();
    // Re-drive: `send*` is silently dropped while signaling reconnects, so the
    // caller re-calls start() with the roster restored by a fresh `welcome`.
    // Re-issue the offer for sessions still negotiating (offer already sent once).
    for (const session of this.sessions.values()) {
      if (session.state === 'negotiating' && !session.pendingOffer && session.offerSent) {
        establishes.push(this.establishSession(session));
      }
    }
    await Promise.all(establishes);
  }

  async handleAnswer(from: string, sdp: string): Promise<void> {
    const session = this.sessions.get(from);
    if (!session || session.state !== 'negotiating') return;
    try {
      await session.pc.setRemoteDescription({ type: 'answer', sdp });
      await this.flushCandidates(session);
    } catch {
      this.fallback(session);
    }
  }

  async handleIce(from: string, candidate: string | null): Promise<void> {
    const session = this.sessions.get(from);
    if (!session || (session.state !== 'negotiating' && session.state !== 'p2p')) return;
    const init = candidate === null ? undefined : deserializeIceCandidate(candidate);
    if (session.pc.remoteDescription === null) {
      session.queuedCandidates.push(init);
    } else {
      await this.applyCandidate(session, init);
    }
  }

  handleViewerLeft(identity: string): void {
    const session = this.sessions.get(identity);
    if (!session) return;
    if (session.state !== 'closed') {
      this.clearTimers(session);
      this.closePc(session);
      this.transition(session, 'closed');
      if (this.allViewersClosed()) this.deps.onAllViewersClosed?.();
    }
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.state !== 'closed') this.deps.signaling.sendBye(session.identity);
      // Mark the session closed synchronously *before* `pc.close()`: a pending
      // establishSession/handleAnswer may otherwise reject from the close and
      // fall back after stop() has already cleared the map (phantom fallback).
      session.state = 'closed';
      this.closeSession(session);
    }
    this.sessions.clear();
    this.emit();
  }

  getViewerStates(): ReadonlyMap<string, ViewerSessionState> {
    const snapshot = new Map<string, ViewerSessionState>();
    for (const [identity, session] of this.sessions) snapshot.set(identity, session.state);
    return snapshot;
  }

  subscribe(listener: (states: ReadonlyMap<string, ViewerSessionState>) => void): () => void {
    this.listeners.add(listener);
    listener(this.getViewerStates());
    return () => this.listeners.delete(listener);
  }

  private async resolveIceServers(): Promise<RTCIceServer[]> {
    if (this.iceServers === undefined) {
      this.iceServers = await this.fetchIceServers();
    }
    return this.iceServers;
  }

  private createSession(identity: string, stream: MediaStream, bitrate: P2pScreenBitrate, iceServers: RTCIceServer[]): ViewerSession {
    const pc = this.createPeerConnection(iceServers);
    const session: ViewerSession = {
      identity,
      pc,
      bitrate,
      state: 'negotiating',
      queuedCandidates: [],
      pendingOffer: false,
      offerSent: false,
      pcClosed: false
    };
    for (const track of stream.getVideoTracks().slice(0, 1)) {
      session.videoSender = pc.addTrack(track);
    }
    for (const track of stream.getAudioTracks().slice(0, 1)) {
      pc.addTrack(track);
    }
    pc.onicecandidate = (event) => this.handleLocalCandidate(session, event);
    pc.oniceconnectionstatechange = () => this.handleIceConnectionState(session);
    this.sessions.set(identity, session);
    return session;
  }

  private async establishSession(session: ViewerSession): Promise<void> {
    session.pendingOffer = true;
    this.clearNegotiationTimer(session);
    try {
      if (session.videoSender) {
        try {
          // Single encoding, no simulcast: cap the video bitrate for this viewer.
          await session.videoSender.setParameters({
            ...session.videoSender.getParameters(),
            encodings: [{ maxBitrate: session.bitrate }]
          });
        } catch {
          // Bitrate tuning is best-effort; a failure must not kill the session.
        }
      }
      const offer = await session.pc.createOffer();
      await session.pc.setLocalDescription(offer);
      if (session.state === 'closed' || session.state === 'livekit-fallback') return; // left or fell back mid-establish
      if (offer.sdp === undefined) throw new Error('createOffer returned no SDP');
      this.deps.signaling.sendOffer(session.identity, offer.sdp);
      session.offerSent = true;
      this.armNegotiationTimer(session);
    } catch {
      this.fallback(session);
    } finally {
      session.pendingOffer = false;
    }
  }

  private handleLocalCandidate(session: ViewerSession, event: RTCPeerConnectionIceEvent): void {
    if (session.state === 'closed' || session.state === 'livekit-fallback') return;
    if (event.candidate) {
      this.deps.signaling.sendIce(session.identity, serializeIceCandidate(event.candidate));
    } else {
      this.deps.signaling.sendIce(session.identity, null);
    }
  }

  private handleIceConnectionState(session: ViewerSession): void {
    if (session.state === 'closed' || session.state === 'livekit-fallback') return;
    const state = session.pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      this.clearTimers(session);
      this.transition(session, 'p2p');
    } else if (state === 'disconnected') {
      if (session.disconnectTimer === undefined) {
        session.disconnectTimer = setTimeout(() => {
          session.disconnectTimer = undefined;
          if (session.state === 'p2p' || session.state === 'negotiating') this.fallback(session);
        }, P2P_ICE_DISCONNECT_TIMEOUT_MS);
      }
    } else if (state === 'failed') {
      this.fallback(session);
    } else if (state === 'closed') {
      this.clearTimers(session);
    }
  }

  private armNegotiationTimer(session: ViewerSession): void {
    this.clearNegotiationTimer(session);
    session.negotiationTimer = setTimeout(() => {
      session.negotiationTimer = undefined;
      if (session.state === 'negotiating') this.fallback(session);
    }, P2P_ICE_NEGOTIATION_TIMEOUT_MS);
  }

  private async flushCandidates(session: ViewerSession): Promise<void> {
    const queued = session.queuedCandidates;
    session.queuedCandidates = [];
    for (const init of queued) {
      await this.applyCandidate(session, init);
    }
  }

  private async applyCandidate(session: ViewerSession, init: RTCIceCandidateInit | undefined): Promise<void> {
    try {
      if (init === undefined) {
        await session.pc.addIceCandidate(undefined); // end-of-candidates (candidate: null on the wire)
      } else {
        await session.pc.addIceCandidate(init);
      }
    } catch {
      // Stale or un-matchable candidates are common with trickle ICE; ignore per candidate.
    }
  }

  private fallback(session: ViewerSession): void {
    if (session.state === 'closed' || session.state === 'livekit-fallback') return;
    this.clearTimers(session);
    this.closePc(session);
    this.transition(session, 'livekit-fallback');
    this.deps.onViewerFallback?.(session.identity);
  }

  private closeSession(session: ViewerSession): void {
    this.clearTimers(session);
    this.closePc(session);
  }

  private closePc(session: ViewerSession): void {
    if (session.pcClosed) return;
    session.pcClosed = true;
    try {
      session.pc.close();
    } catch {
      // Already closed by the browser; nothing to do.
    }
  }

  private clearTimers(session: ViewerSession): void {
    this.clearNegotiationTimer(session);
    if (session.disconnectTimer !== undefined) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = undefined;
    }
  }

  private clearNegotiationTimer(session: ViewerSession): void {
    if (session.negotiationTimer !== undefined) {
      clearTimeout(session.negotiationTimer);
      session.negotiationTimer = undefined;
    }
  }

  private transition(session: ViewerSession, state: ViewerSessionState): void {
    session.state = state;
    this.emit();
  }

  private allViewersClosed(): boolean {
    return this.sessions.size > 0 && [...this.sessions.values()].every((session) => session.state === 'closed');
  }

  private emit(): void {
    const snapshot = this.getViewerStates();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function defaultFetchIceServers(slug: string): () => Promise<RTCIceServer[]> {
  return async () => {
    const response = await apiRequest<{ iceServers: RTCIceServer[] }>(
      `/meetings/${encodeURIComponent(slug)}/ice-servers`,
      IceServersResponseSchema
    );
    return response.iceServers;
  };
}

export function createP2pShareController(dependencies: P2pShareControllerDependencies): P2pShareController {
  return new P2pShareControllerImpl(dependencies);
}
