import { P2P_ICE_DISCONNECT_TIMEOUT_MS, P2P_ICE_NEGOTIATION_TIMEOUT_MS } from '@meeting/contracts';

import { deserializeIceCandidate, serializeIceCandidate } from './p2p-share-controller.js';

export type ViewerP2pState = 'idle' | 'negotiating' | 'p2p' | 'livekit';

/**
 * Minimal signaling surface the viewer controller needs. `P2pSignalingClient`
 * satisfies it structurally, so tests can inject a fake without a WebSocket.
 */
export interface P2pViewerSignaling {
  sendAnswer(to: string, sdp: string): void;
  sendIce(to: string, candidate: string | null): void;
  sendBye(to: string, reason?: string): void;
}

export interface P2pViewerControllerDependencies {
  /** PC factory; defaults to `window.RTCPeerConnection` with the given ICE servers. */
  createPeerConnection?: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  /** Fired once when the viewer moves to `livekit` (the caller subscribes the LiveKit screen track). */
  onFallback?: () => void;
}

interface ViewerPcSession {
  pc: RTCPeerConnection;
  pcClosed: boolean;
  queuedCandidates: Array<RTCIceCandidateInit | undefined>;
  mediaTimer?: ReturnType<typeof setTimeout>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  videoTrack?: MediaStreamTrack;
}

/**
 * Viewer-side P2P session controller for the screen share: one `RTCPeerConnection`
 * against the current sharer, with the fallback state machine
 * (`idle -> negotiating -> p2p`, `negotiating|p2p -> livekit`).
 *
 * The controller never sends offers; it answers the sharer's offer, trickle-ICEs
 * over the signaling channel, and collects the incoming screen audio/video into
 * one `MediaStream`. It falls back to `livekit` (a `bye` with reason `fallback`
 * to the sharer, PC closed, `onFallback` fired) when:
 * - no video RTP arrives within `P2P_ICE_NEGOTIATION_TIMEOUT_MS` of the answer,
 * - ICE stays `disconnected` for `P2P_ICE_DISCONNECT_TIMEOUT_MS`, or
 * - ICE reaches `failed` (covers a crashed/disconnected sharer and a dead link
 *   after media was already flowing — otherwise the viewer would freeze on a
 *   dead P2P stream while the sharer already moved it to the SFU).
 *
 * A fresh offer from the same sharer is treated as renegotiation (the sharer
 * re-drives offers after a signaling reconnect): the old session is torn down
 * and rebuilt, never rejected or double-answered.
 */
export class P2pViewerController {
  private readonly createPeerConnection: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  private readonly onFallback?: () => void;
  private readonly listeners = new Set<(state: ViewerP2pState) => void>();
  private state: ViewerP2pState = 'idle';
  private sharerIdentity?: string;
  private session?: ViewerPcSession;
  private stream: MediaStream | null = null;
  private closed = false;

  constructor(
    private readonly signaling: P2pViewerSignaling,
    private readonly iceServers: RTCIceServer[],
    dependencies: P2pViewerControllerDependencies = {}
  ) {
    this.createPeerConnection = dependencies.createPeerConnection
      ?? ((servers) => new RTCPeerConnection({ iceServers: servers }));
    this.onFallback = dependencies.onFallback;
  }

  /**
   * Accepts an offer from the current sharer and answers it. Offers from anyone
   * else are ignored (the server already enforces this; this is a client-side
   * double check). A new offer from the established sharer renegotiates: the
   * previous PC is closed and a fresh session is built on the new SDP.
   */
  async acceptOffer(from: string, sdp: string): Promise<void> {
    if (this.closed) return;
    if (this.sharerIdentity === undefined) this.sharerIdentity = from;
    if (from !== this.sharerIdentity) return;
    this.teardownSession();
    const session = this.createSession();
    this.session = session;
    this.transition('negotiating');
    try {
      await session.pc.setRemoteDescription({ type: 'offer', sdp });
      if (!this.ownsSession(session)) return;
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      if (!this.ownsSession(session)) return;
      if (answer.sdp === undefined) throw new Error('createAnswer returned no SDP');
      this.signaling.sendAnswer(this.sharerIdentity, answer.sdp);
      await this.flushCandidates(session);
      if (!this.ownsSession(session)) return;
      this.armMediaTimer(session);
    } catch {
      if (this.ownsSession(session)) this.fallback(session);
    }
  }

  async handleIce(from: string, candidate: string | null): Promise<void> {
    if (this.closed || this.sharerIdentity === undefined || from !== this.sharerIdentity) return;
    const session = this.session;
    if (session === undefined || session.pcClosed) return;
    if (session.pc.remoteDescription === null) {
      session.queuedCandidates.push(candidate === null ? undefined : deserializeIceCandidate(candidate));
      return;
    }
    await this.applyCandidate(session, candidate === null ? undefined : deserializeIceCandidate(candidate));
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  getState(): ViewerP2pState {
    return this.state;
  }

  /** Identity of the current P2P sharer, if a session was ever established. */
  getSharerIdentity(): string | undefined {
    return this.sharerIdentity;
  }

  subscribe(listener: (state: ViewerP2pState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Terminates the session: closes the PC, clears timers, and returns to `idle`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardownSession();
    this.sharerIdentity = undefined;
    this.transition('idle');
  }

  private createSession(): ViewerPcSession {
    const pc = this.createPeerConnection(this.iceServers);
    const session: ViewerPcSession = { pc, pcClosed: false, queuedCandidates: [] };
    pc.ontrack = (event) => this.handleTrack(session, event);
    pc.onicecandidate = (event) => this.handleLocalCandidate(session, event);
    pc.oniceconnectionstatechange = () => this.handleIceConnectionState(session);
    return session;
  }

  private teardownSession(): void {
    const session = this.session;
    this.session = undefined;
    this.stream = null;
    if (session !== undefined) {
      this.clearMediaTimer(session);
      this.clearDisconnectTimer(session);
      if (session.videoTrack) session.videoTrack.onunmute = null;
      this.closePc(session);
    }
  }

  private ownsSession(session: ViewerPcSession): boolean {
    return this.session === session && !session.pcClosed && !this.closed;
  }

  private handleTrack(session: ViewerPcSession, event: RTCTrackEvent): void {
    if (!this.ownsSession(session)) return;
    const { track } = event;
    if (event.streams.length > 0) {
      this.stream = event.streams[0];
    } else {
      // The sharer adds tracks without explicit streams; assemble our own stream.
      if (this.stream === null) this.stream = new MediaStream();
      this.stream.addTrack(track);
    }
    if (track.kind === 'video') this.watchVideoMedia(session, track);
  }

  /**
   * The browser reports whether a remote track is actually receiving data via
   * its muted state: a track that arrives muted unmutes on the first RTP. Until
   * the video track unmutes, the 8s no-media timer keeps running.
   */
  private watchVideoMedia(session: ViewerPcSession, track: MediaStreamTrack): void {
    session.videoTrack = track;
    track.onunmute = () => this.markMediaReceived(session);
    if (!track.muted) this.markMediaReceived(session);
  }

  private markMediaReceived(session: ViewerPcSession): void {
    if (!this.ownsSession(session) || this.state !== 'negotiating') return;
    this.clearMediaTimer(session);
    this.transition('p2p');
  }

  private handleLocalCandidate(session: ViewerPcSession, event: RTCPeerConnectionIceEvent): void {
    if (!this.ownsSession(session) || this.sharerIdentity === undefined) return;
    if (event.candidate) {
      this.signaling.sendIce(this.sharerIdentity, serializeIceCandidate(event.candidate));
    } else {
      this.signaling.sendIce(this.sharerIdentity, null);
    }
  }

  private async flushCandidates(session: ViewerPcSession): Promise<void> {
    const queued = session.queuedCandidates;
    session.queuedCandidates = [];
    for (const init of queued) {
      await this.applyCandidate(session, init);
    }
  }

  private async applyCandidate(session: ViewerPcSession, init: RTCIceCandidateInit | undefined): Promise<void> {
    if (!this.ownsSession(session)) return;
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

  private armMediaTimer(session: ViewerPcSession): void {
    this.clearMediaTimer(session);
    if (this.state !== 'negotiating') return; // media already flowing
    session.mediaTimer = setTimeout(() => {
      session.mediaTimer = undefined;
      if (this.ownsSession(session) && this.state === 'negotiating') this.fallback(session);
    }, P2P_ICE_NEGOTIATION_TIMEOUT_MS);
  }

  private handleIceConnectionState(session: ViewerPcSession): void {
    if (!this.ownsSession(session)) return;
    const state = session.pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      this.clearDisconnectTimer(session);
    } else if (state === 'disconnected') {
      if (session.disconnectTimer === undefined) {
        session.disconnectTimer = setTimeout(() => {
          session.disconnectTimer = undefined;
          if (this.ownsSession(session) && (this.state === 'negotiating' || this.state === 'p2p')) {
            this.fallback(session);
          }
        }, P2P_ICE_DISCONNECT_TIMEOUT_MS);
      }
    } else if (state === 'failed') {
      if (this.state === 'negotiating' || this.state === 'p2p') this.fallback(session);
    } else if (state === 'closed') {
      this.clearDisconnectTimer(session);
    }
  }

  private fallback(session: ViewerPcSession): void {
    if (!this.ownsSession(session) || this.closed || (this.state !== 'negotiating' && this.state !== 'p2p')) return;
    this.clearMediaTimer(session);
    this.clearDisconnectTimer(session);
    this.closePc(session);
    this.session = undefined;
    this.stream = null;
    if (this.sharerIdentity !== undefined) this.signaling.sendBye(this.sharerIdentity, 'fallback');
    this.transition('livekit');
    this.onFallback?.();
  }

  private clearMediaTimer(session: ViewerPcSession): void {
    if (session.mediaTimer !== undefined) {
      clearTimeout(session.mediaTimer);
      session.mediaTimer = undefined;
    }
  }

  private clearDisconnectTimer(session: ViewerPcSession): void {
    if (session.disconnectTimer !== undefined) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = undefined;
    }
  }

  private closePc(session: ViewerPcSession): void {
    if (session.pcClosed) return;
    session.pcClosed = true;
    try {
      session.pc.close();
    } catch {
      // Already closed by the browser; nothing to do.
    }
  }

  private transition(state: ViewerP2pState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

export function createP2pViewerController(
  signaling: P2pViewerSignaling,
  iceServers: RTCIceServer[],
  dependencies?: P2pViewerControllerDependencies
): P2pViewerController {
  return new P2pViewerController(signaling, iceServers, dependencies);
}
