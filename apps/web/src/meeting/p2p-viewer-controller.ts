import {
  P2P_ICE_DISCONNECT_TIMEOUT_MS,
  P2P_ICE_NEGOTIATION_TIMEOUT_MS,
  P2P_RTP_STALL_TIMEOUT_MS,
  type P2pTurnProvider
} from '@meeting/contracts';

import { inspectP2pMediaHealth, type P2pMediaHealth } from './p2p-media-health.js';
import { configureOpusSdp, deserializeIceCandidate, serializeIceCandidate } from './p2p-share-controller.js';

export type ViewerP2pState = 'idle' | 'negotiating' | 'p2p' | 'turn' | 'livekit';

const P2P_QUALITY_MIN_INTERVAL_PACKETS = 20;
const P2P_QUALITY_LOSS_THRESHOLD = 0.15;
const P2P_QUALITY_BAD_SAMPLE_LIMIT = 8;
const P2P_EARLY_ICE_MAX_CANDIDATES = 32;

/**
 * Minimal signaling surface the viewer controller needs. `P2pSignalingClient`
 * satisfies it structurally, so tests can inject a fake without a WebSocket.
 */
export interface P2pViewerSignaling {
  sendAnswer(to: string, sdp: string, generation?: string): void;
  sendIce(to: string, candidate: string | null, generation?: string): void;
  sendMediaReady(to: string, generation?: string): void;
  sendRetry(to: string): void;
  sendBye(to: string, reason?: string): void;
}

export interface P2pViewerControllerDependencies {
  /** PC factory; defaults to `window.RTCPeerConnection` with the given ICE servers and policy. */
  createPeerConnection?: (iceServers: RTCIceServer[], iceTransportPolicy?: RTCIceTransportPolicy) => RTCPeerConnection;
  /** ICE policy for the next peer connection. `relay` forces TURN. */
  iceTransportPolicy?: RTCIceTransportPolicy;
  turnProvider?: P2pTurnProvider;
  /** Fired once when the viewer moves to `livekit` (the caller subscribes the LiveKit screen track). */
  onFallback?: () => void;
  /** Requests the LiveKit handover; invoke `complete` only after its first frame is rendered. */
  onFallbackRequested?: (complete: () => void) => void;
  healthSampleIntervalMs?: number;
  now?: () => number;
  scheduleHealthChecks?: (check: () => Promise<void>, intervalMs: number) => () => void;
}

interface ViewerPcSession {
  pc: RTCPeerConnection;
  iceTransportPolicy: RTCIceTransportPolicy;
  turnProvider: P2pTurnProvider;
  generation?: string;
  pcClosed: boolean;
  queuedCandidates: Array<RTCIceCandidateInit | undefined>;
  mediaTimer?: ReturnType<typeof setTimeout>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  videoTrack?: MediaStreamTrack;
  stopHealthMonitor?: () => void;
  lastBytesReceived: number;
  lastFramesDecoded: number;
  lastProgressAt: number;
  lastPacketsReceived?: number;
  lastPacketsLost?: number;
  lastFreezeCount?: number;
  poorQualitySamples: number;
  mediaReadySent: boolean;
  healthSampleTail: Promise<void>;
  fallbackPending: boolean;
  /** One bounded media-timer extension while ICE is still making progress. */
  mediaTimerExtended: boolean;
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
  private iceTransportPolicy: RTCIceTransportPolicy;
  private turnProvider: P2pTurnProvider;
  private readonly onFallback?: () => void;
  private readonly onFallbackRequested?: (complete: () => void) => void;
  private readonly healthSampleIntervalMs: number;
  private readonly now: () => number;
  private readonly scheduleHealthChecks: (check: () => Promise<void>, intervalMs: number) => () => void;
  private readonly listeners = new Set<(state: ViewerP2pState) => void>();
  private state: ViewerP2pState = 'idle';
  private sharerIdentity?: string;
  private session?: ViewerPcSession;
  private stream: MediaStream | null = null;
  private earlyIce?: { from: string; generation?: string; candidates: Array<string | null> };
  private closed = false;

  constructor(
    private readonly signaling: P2pViewerSignaling,
    private iceServers: RTCIceServer[],
    dependencies: P2pViewerControllerDependencies = {}
  ) {
    const createPeerConnection = dependencies.createPeerConnection
      ?? ((servers, policy) => new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: policy }));
    this.createPeerConnection = (servers) => createPeerConnection(servers, this.iceTransportPolicy);
    this.iceTransportPolicy = dependencies.iceTransportPolicy ?? 'all';
    this.turnProvider = dependencies.turnProvider ?? 'coturn';
    this.onFallback = dependencies.onFallback;
    this.onFallbackRequested = dependencies.onFallbackRequested;
    this.healthSampleIntervalMs = dependencies.healthSampleIntervalMs ?? 1_000;
    this.now = dependencies.now ?? Date.now;
    this.scheduleHealthChecks = dependencies.scheduleHealthChecks ?? ((check, intervalMs) => {
      const timer = setInterval(() => { void check(); }, intervalMs);
      return () => clearInterval(timer);
    });
  }

  /**
   * Accepts an offer from the current sharer and answers it. Offers from anyone
   * else are ignored (the server already enforces this; this is a client-side
   * double check). A new offer from the established sharer renegotiates: the
   * previous PC is closed and a fresh session is built on the new SDP.
   */
  async acceptOffer(from: string, sdp: string, generation?: string): Promise<void> {
    if (this.closed) return;
    if (this.sharerIdentity === undefined) this.sharerIdentity = from;
    if (from !== this.sharerIdentity) return;
    this.teardownSession();
    const session = this.createSession(generation);
    if (this.earlyIce?.from === from
      && (generation === undefined || this.earlyIce.generation === undefined || this.earlyIce.generation === generation)) {
      session.queuedCandidates.push(...this.earlyIce.candidates.map((candidate) =>
        candidate === null ? undefined : deserializeIceCandidate(candidate)
      ));
    }
    this.earlyIce = undefined;
    this.session = session;
    this.transition('negotiating');
    try {
      await session.pc.setRemoteDescription({ type: 'offer', sdp });
      if (!this.ownsSession(session)) return;
      const answer = await session.pc.createAnswer();
      const answerSdp = answer.sdp !== undefined ? configureOpusSdp(answer.sdp) : undefined;
      const answerWithSdp = answerSdp !== undefined ? { ...answer, sdp: answerSdp } : answer;
      await session.pc.setLocalDescription(answerWithSdp);
      if (!this.ownsSession(session)) return;
      if (answerWithSdp.sdp === undefined) throw new Error('createAnswer returned no SDP');
      if (session.generation === undefined) this.signaling.sendAnswer(this.sharerIdentity, answerWithSdp.sdp);
      else this.signaling.sendAnswer(this.sharerIdentity, answerWithSdp.sdp, session.generation);
      await this.flushCandidates(session);
      if (!this.ownsSession(session)) return;
      this.armMediaTimer(session);
      this.armHealthMonitor(session);
    } catch {
      if (this.ownsSession(session)) this.fallback(session);
    }
  }

  async handleIce(from: string, candidate: string | null, generation?: string): Promise<void> {
    if (this.closed) return;
    if (this.sharerIdentity === undefined) {
      if (this.earlyIce?.from !== from || this.earlyIce.generation !== generation) {
        this.earlyIce = { from, generation, candidates: [] };
      }
      if (this.earlyIce.candidates.length >= P2P_EARLY_ICE_MAX_CANDIDATES) {
        this.earlyIce.candidates.shift();
      }
      this.earlyIce.candidates.push(candidate);
      return;
    }
    if (from !== this.sharerIdentity) return;
    const session = this.session;
    if (session === undefined || session.pcClosed) return;
    if (generation !== undefined && session.generation !== undefined && generation !== session.generation) return;
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

  /**
   * Replaces the ICE servers used by the next session (the next offer builds a
   * fresh PC). Called after the page refreshes soon-to-expire TURN
   * credentials, so late shares still gather relay candidates.
   */
  updateIceServers(
    iceServers: RTCIceServer[],
    turnProvider: P2pTurnProvider = this.turnProvider
  ): void {
    this.iceServers = iceServers;
    this.turnProvider = turnProvider;
    const session = this.session;
    if (session !== undefined && !session.pcClosed) {
      if (this.state !== 'turn') session.turnProvider = turnProvider;
      try {
        session.pc.setConfiguration({
          iceServers,
          iceTransportPolicy: session.iceTransportPolicy
        });
      } catch {
        // The browser may reject a configuration update while closing; the
        // next session still receives the refreshed credentials.
      }
    }
  }

  /** Sets the policy used by the next peer connection. */
  setIceTransportPolicy(policy: RTCIceTransportPolicy): void {
    this.iceTransportPolicy = policy;
  }

  /** Requests an immediate handover to the LiveKit SFU path. */
  requestSfu(): void {
    if (this.closed) return;
    const session = this.session;
    if (session !== undefined
      && (this.state === 'negotiating' || this.state === 'p2p' || this.state === 'turn')) {
      this.fallback(session);
      return;
    }
    this.transition('livekit');
  }

  async getStatsReport(): Promise<RTCStatsReport | undefined> {
    const session = this.session;
    if (session === undefined || session.pcClosed || this.closed) return undefined;
    return session.pc.getStats();
  }

  /** Identity of the current P2P sharer, if a session was ever established. */
  getSharerIdentity(): string | undefined {
    return this.sharerIdentity;
  }

  getTurnProvider(): P2pTurnProvider | undefined {
    return this.state === 'turn' ? this.session?.turnProvider : undefined;
  }

  /**
   * Asks the sharer (via the retry button) to re-drive a fresh offer for this
   * viewer. The sharer rebuilds the session with a new PC and ICE, and this
   * viewer's `acceptOffer` treats the fresh offer as a renegotiation.
   */
  requestRetry(): void {
    if (this.closed || this.sharerIdentity === undefined) return;
    this.signaling.sendRetry(this.sharerIdentity);
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
    this.earlyIce = undefined;
    this.transition('idle');
  }

  private createSession(generation?: string): ViewerPcSession {
    const pc = this.createPeerConnection(this.iceServers);
    const session: ViewerPcSession = {
      pc,
      iceTransportPolicy: this.iceTransportPolicy,
      turnProvider: this.turnProvider,
      generation,
      pcClosed: false,
      queuedCandidates: [],
      lastBytesReceived: 0,
      lastFramesDecoded: 0,
      lastProgressAt: this.now(),
      poorQualitySamples: 0,
      mediaReadySent: false,
      healthSampleTail: Promise.resolve(),
      fallbackPending: false,
      mediaTimerExtended: false
    };
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
      this.clearHealthMonitor(session);
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
    track.onunmute = () => { void this.queueMediaHealthSample(session); };
    if (!track.muted) void this.queueMediaHealthSample(session);
  }

  private async sampleMediaHealth(session: ViewerPcSession): Promise<void> {
    if (!this.ownsSession(session) || session.fallbackPending) return;
    try {
      const health = inspectP2pMediaHealth(await session.pc.getStats());
      if (!this.ownsSession(session) || session.fallbackPending) return;
      const progressed = health.bytesReceived > session.lastBytesReceived
        || health.framesDecoded > session.lastFramesDecoded;
      if (progressed) {
        session.lastBytesReceived = health.bytesReceived;
        session.lastFramesDecoded = health.framesDecoded;
        session.lastProgressAt = this.now();
      }

      // Media that actually decodes is the success signal; the path is only a
      // classification. `getStats` may transiently lack the selected pair or
      // its candidate stats (path 'unknown') even while RTP is flowing — that
      // must not be mistaken for a failed negotiation, or the viewer falls
      // back to the SFU at the 8s mark despite a working direct stream.
      const hasDecodedVideo = session.videoTrack !== undefined
        && !session.videoTrack.muted
        && health.bytesReceived > 0
        && health.framesDecoded > 0;
      if (this.state === 'negotiating' && hasDecodedVideo) {
        this.clearMediaTimer(session);
        if (!session.mediaReadySent && this.sharerIdentity !== undefined) {
          session.mediaReadySent = true;
          if (session.generation === undefined) this.signaling.sendMediaReady(this.sharerIdentity);
          else this.signaling.sendMediaReady(this.sharerIdentity, session.generation);
        }
        // A relay-only peer connection can prove its path from the policy
        // once real video has decoded, even when mobile WebRTC stats omit the
        // selected candidate-pair metadata.
        if (health.path === 'relay'
          || (health.path === 'unknown' && session.iceTransportPolicy === 'relay')) this.transition('turn');
        else if (health.path === 'direct') this.transition('p2p');
      } else if ((this.state === 'p2p' || this.state === 'turn') && health.path !== 'unknown') {
        const classifiedState: ViewerP2pState = health.path === 'relay' ? 'turn' : 'p2p';
        if (classifiedState !== this.state) this.transition(classifiedState);
      }
      if (this.observeQuality(session, health)
        && (this.state === 'p2p' || this.state === 'turn')) {
        this.fallback(session);
        return;
      }
      const stallEligible = this.state === 'p2p' || this.state === 'turn'
        || (this.state === 'negotiating' && session.mediaReadySent);
      if (stallEligible
        && this.now() - session.lastProgressAt >= P2P_RTP_STALL_TIMEOUT_MS) {
        this.fallback(session);
      }
    } catch {
      // A transient getStats failure is handled by the negotiation/stall timers.
    }
  }

  private armHealthMonitor(session: ViewerPcSession): void {
    this.clearHealthMonitor(session);
    session.stopHealthMonitor = this.scheduleHealthChecks(
      async () => {
        await this.queueMediaHealthSample(session);
      },
      this.healthSampleIntervalMs
    );
  }

  private async queueMediaHealthSample(session: ViewerPcSession): Promise<void> {
    session.healthSampleTail = session.healthSampleTail
      .then(() => this.sampleMediaHealth(session))
      .catch(() => undefined);
    await session.healthSampleTail;
  }

  private observeQuality(session: ViewerPcSession, health: P2pMediaHealth): boolean {
    const previousReceived = session.lastPacketsReceived;
    const previousLost = session.lastPacketsLost;
    const previousFreezes = session.lastFreezeCount;
    session.lastPacketsReceived = health.packetsReceived;
    session.lastPacketsLost = health.packetsLost;
    session.lastFreezeCount = health.freezeCount;

    if (previousReceived === undefined || previousLost === undefined || previousFreezes === undefined) {
      session.poorQualitySamples = 0;
      return false;
    }

    const received = health.packetsReceived - previousReceived;
    const lost = health.packetsLost - previousLost;
    const freezes = health.freezeCount - previousFreezes;
    if (received < 0 || lost < 0 || freezes < 0) {
      session.poorQualitySamples = 0;
      return false;
    }

    const packetPopulation = received + lost;
    const highLoss = packetPopulation >= P2P_QUALITY_MIN_INTERVAL_PACKETS
      && lost / packetPopulation >= P2P_QUALITY_LOSS_THRESHOLD;
    if (highLoss || freezes > 0) session.poorQualitySamples++;
    else session.poorQualitySamples = 0;
    return session.poorQualitySamples >= P2P_QUALITY_BAD_SAMPLE_LIMIT;
  }

  private handleLocalCandidate(session: ViewerPcSession, event: RTCPeerConnectionIceEvent): void {
    if (!this.ownsSession(session) || this.sharerIdentity === undefined) return;
    if (event.candidate) {
      const candidate = serializeIceCandidate(event.candidate);
      if (session.generation === undefined) this.signaling.sendIce(this.sharerIdentity, candidate);
      else this.signaling.sendIce(this.sharerIdentity, candidate, session.generation);
    } else {
      if (session.generation === undefined) this.signaling.sendIce(this.sharerIdentity, null);
      else this.signaling.sendIce(this.sharerIdentity, null, session.generation);
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
      if (!this.ownsSession(session) || this.state !== 'negotiating') return;
      const iceState = session.pc.iceConnectionState;
      if (!session.mediaTimerExtended && iceState === 'checking') {
        // ICE is still making progress (fresh relay allocation, asymmetric
        // NAT re-check, or the sharer's automatic re-offer window): extend the
        // deadline once instead of abandoning a still-viable negotiation. A
        // stalled state ('new' with no checks) or a connected link with no
        // media keeps the fail-fast behavior.
        session.mediaTimerExtended = true;
        this.armMediaTimer(session);
        return;
      }
      this.fallback(session);
    }, P2P_ICE_NEGOTIATION_TIMEOUT_MS);
  }

  private handleIceConnectionState(session: ViewerPcSession): void {
    if (!this.ownsSession(session)) return;
    const state = session.pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      this.clearDisconnectTimer(session);
    } else if (state === 'checking') {
      // Progress while negotiating re-arms the no-media deadline so a slow
      // convergence is not killed by a timer measured from the answer alone.
      if (this.state === 'negotiating' && !session.mediaReadySent) this.armMediaTimer(session);
    } else if (state === 'disconnected') {
      if (session.disconnectTimer === undefined) {
        session.disconnectTimer = setTimeout(() => {
          session.disconnectTimer = undefined;
          if (this.ownsSession(session)
            && (this.state === 'negotiating' || this.state === 'p2p' || this.state === 'turn')) {
            this.fallback(session);
          }
        }, P2P_ICE_DISCONNECT_TIMEOUT_MS);
      }
    } else if (state === 'failed') {
      if (this.state === 'negotiating' || this.state === 'p2p' || this.state === 'turn') this.fallback(session);
    } else if (state === 'closed') {
      this.clearDisconnectTimer(session);
    }
  }

  private fallback(session: ViewerPcSession): void {
    if (!this.ownsSession(session)
      || this.closed
      || (this.state !== 'negotiating' && this.state !== 'p2p' && this.state !== 'turn')) return;
    session.fallbackPending = true;
    this.clearMediaTimer(session);
    this.clearDisconnectTimer(session);
    this.clearHealthMonitor(session);
    if (this.sharerIdentity !== undefined) this.signaling.sendBye(this.sharerIdentity, 'fallback');
    this.transition('livekit');
    this.onFallback?.();
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      this.closePc(session);
      if (this.session === session) {
        this.session = undefined;
        this.stream = null;
      }
    };
    if (this.onFallbackRequested) this.onFallbackRequested(complete);
    else complete();
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

  private clearHealthMonitor(session: ViewerPcSession): void {
    if (session.stopHealthMonitor !== undefined) {
      session.stopHealthMonitor();
      session.stopHealthMonitor = undefined;
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
