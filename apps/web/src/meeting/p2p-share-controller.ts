import {
  P2P_ICE_DISCONNECT_TIMEOUT_MS,
  P2P_ICE_NEGOTIATION_TIMEOUT_MS,
  type ScreenShareCodec
} from '@meeting/contracts';
import { Type } from '@sinclair/typebox';

import { apiRequest } from '../api/client.js';
import { inspectP2pMediaHealth } from './p2p-media-health.js';
import type { Peer } from './p2p-signaling.js';

export type ViewerSessionState = 'negotiating' | 'p2p' | 'turn' | 'livekit-fallback' | 'closed';

/** Lower bound for a single viewer's share of the aggregate P2P budget. */
export const P2P_VIEWER_BITRATE_FLOOR = 1_000_000;

/**
 * Per-viewer encoding settings applied to each P2P `RTCPeerConnection`.
 * Mirrors `ScreenSharePublishOptions` so both the SFU fallback and the direct
 * path encode the share the same way (codec, frame rate, degradation).
 */
export interface P2pShareOptions {
  maxBitrate: number;
  frameRate: number;
  degradationPreference: RTCDegradationPreference;
  codec: ScreenShareCodec;
}

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
  start(stream: MediaStream, options: P2pShareOptions, viewers: Peer[]): Promise<void>;
  handleAnswer(from: string, sdp: string): Promise<void>;
  handleIce(from: string, candidate: string | null): Promise<void>;
  handleMediaReady(from: string): void;
  handleViewerLeft(identity: string): void;
  /** A viewer asked (via the retry button) for a fresh offer: rebuild their session. */
  handleRetry(from: string): void;
  /** The sharer asked to re-drive every viewer: fresh sessions for the whole roster. */
  retryAll(viewers: Peer[]): Promise<void>;
  stop(): Promise<void>;   // 关闭全部 PC，广播 bye
  getViewerStates(): ReadonlyMap<string, ViewerSessionState>;
  getStatsReports(): Promise<RTCStatsReport[]>;
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
  options: P2pShareOptions;
  state: ViewerSessionState;
  queuedCandidates: Array<RTCIceCandidateInit | undefined>;
  pendingOffer: boolean;
  offerSent: boolean;
  pcClosed: boolean;
  transportConnected: boolean;
  negotiationTimer?: ReturnType<typeof setTimeout>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
}

class P2pShareControllerImpl implements P2pShareController {
  private readonly createPeerConnection: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  private readonly fetchIceServers: () => Promise<RTCIceServer[]>;
  private readonly sessions = new Map<string, ViewerSession>();
  private readonly listeners = new Set<(states: ReadonlyMap<string, ViewerSessionState>) => void>();
  private iceServers?: RTCIceServer[];
  /** The captured share the sessions publish; kept for retry re-drives. */
  private activeStream?: MediaStream;
  /** The total (aggregate) P2P budget chosen by the sharer, before division. */
  private activeOptions?: P2pShareOptions;

  constructor(private readonly deps: P2pShareControllerDependencies) {
    this.createPeerConnection = deps.createPeerConnection
      ?? ((servers) => new RTCPeerConnection({ iceServers: servers }));
    this.fetchIceServers = deps.fetchIceServers ?? defaultFetchIceServers(deps.slug);
  }

  async start(stream: MediaStream, options: P2pShareOptions, viewers: Peer[]): Promise<void> {
    this.activeStream = stream;
    this.activeOptions = options;
    const iceServers = await this.resolveIceServers();
    const viewerOptions = this.divideOptions(options, viewers.length);
    const establishes: Promise<void>[] = [];
    for (const viewer of viewers) {
      const existing = this.sessions.get(viewer.identity);
      // A viewer that left and rejoined starts a fresh session; p2p/fallback sessions keep running.
      if (existing && existing.state !== 'closed') continue;
      if (existing) this.closeSession(existing);
      const session = this.createSession(viewer.identity, stream, viewerOptions, iceServers);
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
    // The roster may have grown or shrunk since the previous drive: re-divide
    // the aggregate budget across the sessions that are actually active.
    this.rebalanceBitrates();
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
    if (!session || (session.state !== 'negotiating' && session.state !== 'p2p' && session.state !== 'turn')) return;
    const init = candidate === null ? undefined : deserializeIceCandidate(candidate);
    if (session.pc.remoteDescription === null) {
      session.queuedCandidates.push(init);
    } else {
      await this.applyCandidate(session, init);
    }
  }

  handleMediaReady(from: string): void {
    const session = this.sessions.get(from);
    if (!session || session.state !== 'negotiating' || !session.transportConnected) return;
    this.clearTimers(session);
    this.transition(session, 'p2p');
    void this.updateTransportState(session);
  }

  handleViewerLeft(identity: string): void {
    const session = this.sessions.get(identity);
    if (!session) return;
    if (session.state !== 'closed') {
      this.clearTimers(session);
      this.closePc(session);
      this.transition(session, 'closed');
      // Free the departed viewer's share of the aggregate budget for the rest.
      this.rebalanceBitrates();
      if (this.allViewersClosed()) this.deps.onAllViewersClosed?.();
    }
  }

  handleRetry(from: string): void {
    if (this.activeStream === undefined || this.activeOptions === undefined) return;
    const existing = this.sessions.get(from);
    if (existing) this.closeSession(existing);
    // A fresh PC and offer: the viewer rebuilds its session on the new offer,
    // so stale candidates from a failed attempt can never poison the retry.
    void this.resolveIceServers().then((iceServers) => {
      // The share may have stopped while the credentials were in flight.
      if (this.activeStream === undefined || this.activeOptions === undefined) return;
      const session = this.createSession(
        from,
        this.activeStream,
        this.divideOptions(this.activeOptions, this.activeViewerCount()),
        iceServers
      );
      void this.establishSession(session);
    });
  }

  async retryAll(viewers: Peer[]): Promise<void> {
    if (this.activeStream === undefined || this.activeOptions === undefined) return;
    const iceServers = await this.resolveIceServers();
    const options = this.divideOptions(this.activeOptions, viewers.length);
    for (const session of this.sessions.values()) {
      if (session.state !== 'closed') {
        this.clearTimers(session);
        this.closePc(session);
      }
    }
    this.sessions.clear();
    const establishes: Promise<void>[] = [];
    for (const viewer of viewers) {
      const session = this.createSession(viewer.identity, this.activeStream, options, iceServers);
      establishes.push(this.establishSession(session));
    }
    this.emit();
    await Promise.all(establishes);
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

  async getStatsReports(): Promise<RTCStatsReport[]> {
    const active = [...this.sessions.values()].filter((session) => !session.pcClosed);
    return Promise.all(active.map((session) => session.pc.getStats()));
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

  private createSession(identity: string, stream: MediaStream, options: P2pShareOptions, iceServers: RTCIceServer[]): ViewerSession {
    const pc = this.createPeerConnection(iceServers);
    const session: ViewerSession = {
      identity,
      pc,
      options,
      state: 'negotiating',
      queuedCandidates: [],
      pendingOffer: false,
      offerSent: false,
      pcClosed: false,
      transportConnected: false
    };
    for (const track of stream.getVideoTracks().slice(0, 1)) {
      // A transceiver (not `addTrack`) so we can set codec preferences before
      // the offer is created; the bitrate/frame-rate cap is applied later via
      // `setParameters` so a failure there stays best-effort.
      const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });
      applyCodecPreference(transceiver, options.codec);
      session.videoSender = transceiver.sender;
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
          // Single encoding, no simulcast: cap the video bitrate and frame
          // rate for this viewer, and apply the chosen degradation policy.
          // `scaleResolutionDownBy` normalizes the transmitted resolution to
          // 1080p (or 720p when the capture is smaller) regardless of the
          // display-scaling resolution the browser captured at.
          const { options } = session;
          const scale = computeResolutionScale(
            session.videoSender.track?.getSettings?.() ?? {}
          );
          await session.videoSender.setParameters({
            ...session.videoSender.getParameters(),
            encodings: [{
              maxBitrate: options.maxBitrate,
              maxFramerate: options.frameRate,
              ...(scale === undefined ? {} : { scaleResolutionDownBy: scale })
            }],
            degradationPreference: options.degradationPreference
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
      session.transportConnected = true;
      this.clearDisconnectTimer(session);
    } else if (state === 'disconnected') {
      session.transportConnected = false;
      if (session.disconnectTimer === undefined) {
        session.disconnectTimer = setTimeout(() => {
          session.disconnectTimer = undefined;
          if (session.state === 'p2p' || session.state === 'turn' || session.state === 'negotiating') {
            this.fallback(session);
          }
        }, P2P_ICE_DISCONNECT_TIMEOUT_MS);
      }
    } else if (state === 'failed') {
      session.transportConnected = false;
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

  private async updateTransportState(session: ViewerSession): Promise<void> {
    try {
      const health = inspectP2pMediaHealth(await session.pc.getStats());
      if (this.sessions.get(session.identity) !== session || session.pcClosed) return;
      if (health.path === 'relay' && session.state === 'p2p') this.transition(session, 'turn');
    } catch {
      // Candidate-pair stats may be briefly unavailable after media-ready.
      // The usable session remains active and later UI stats can classify it.
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
    this.clearDisconnectTimer(session);
  }

  private clearDisconnectTimer(session: ViewerSession): void {
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

  /**
   * Divides the aggregate P2P budget across the viewers that will share it.
   * Every viewer otherwise gets the full budget, so N parallel
   * `RTCPeerConnection`s each run their own congestion controller against the
   * same uplink: the first-established link grabs the bandwidth and the rest
   * starve. Dividing up front keeps the aggregate at (or below) the chosen
   * tier, so viewers contend for quality instead of bandwidth.
   */
  private divideOptions(options: P2pShareOptions, viewerCount: number): P2pShareOptions {
    const viewers = Math.max(1, viewerCount);
    return { ...options, maxBitrate: Math.max(P2P_VIEWER_BITRATE_FLOOR, Math.floor(options.maxBitrate / viewers)) };
  }

  /** Counts sessions that still consume P2P bandwidth (negotiating/p2p/turn). */
  private activeViewerCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state === 'negotiating' || session.state === 'p2p' || session.state === 'turn') count++;
    }
    return Math.max(1, count);
  }

  /** Re-applies the divided per-viewer bitrate to every active session. */
  private rebalanceBitrates(): void {
    if (this.activeOptions === undefined) return;
    const options = this.divideOptions(this.activeOptions, this.activeViewerCount());
    for (const session of this.sessions.values()) {
      if (session.state === 'closed' || session.state === 'livekit-fallback') continue;
      session.options = options;
      if (session.videoSender) {
        try {
          const scale = computeResolutionScale(session.videoSender.track?.getSettings?.() ?? {});
          void session.videoSender.setParameters({
            ...session.videoSender.getParameters(),
            encodings: [{
              maxBitrate: options.maxBitrate,
              maxFramerate: options.frameRate,
              ...(scale === undefined ? {} : { scaleResolutionDownBy: scale })
            }],
            degradationPreference: options.degradationPreference
          }).catch(() => undefined);
        } catch {
          // Bitrate tuning is best-effort; a failure must not kill the session.
        }
      }
    }
  }

  private emit(): void {
    const snapshot = this.getViewerStates();
    for (const listener of this.listeners) listener(snapshot);
  }
}

/**
 * Orders the transceiver's codec list so the chosen codec is preferred during
 * SDP negotiation. `auto` keeps the browser default. Best-effort: browsers
 * without `RTCRtpSender.getCapabilities` (or without `setCodecPreferences`)
 * simply use their default codec.
 */
function applyCodecPreference(transceiver: RTCRtpTransceiver, codec: ScreenShareCodec): void {
  if (codec === 'auto') return;
  const capabilities = typeof RTCRtpSender !== 'undefined'
    ? RTCRtpSender.getCapabilities?.('video')?.codecs
    : undefined;
  if (!capabilities || capabilities.length === 0) return;
  const wanted = codec === 'h264' ? 'video/h264' : 'video/vp8';
  const fallback = codec === 'h264' ? ['video/vp8', 'video/vp9'] : ['video/h264', 'video/vp9'];
  const preferred = capabilities
    .filter((codecCapability) => codecCapability.mimeType.toLowerCase() === wanted)
    .concat(capabilities.filter((codecCapability) => fallback.includes(codecCapability.mimeType.toLowerCase())));
  if (preferred.length > 0) transceiver.setCodecPreferences(preferred);
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

/**
 * Computes the `scaleResolutionDownBy` that normalizes a captured track to a
 * standard tier: 1080p when the capture is at least 1920x1080, 720p when it is
 * at least 1280x720, native otherwise (never upscale). Returns `undefined` when
 * no scaling is needed or the track reports no dimensions. Display-scaled
 * Windows captures (e.g. 1536x864 on a 125% 1080p screen) otherwise transmit
 * their odd native resolution on both the P2P and the SFU path.
 */
export function computeResolutionScale(settings: { width?: number; height?: number }): number | undefined {
  const width = settings.width;
  const height = settings.height;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  const target = width >= 1920 && height >= 1080
    ? { width: 1920, height: 1080 }
    : width >= 1280 && height >= 720
      ? { width: 1280, height: 720 }
      : undefined;
  if (target === undefined) return undefined;
  const scale = Math.min(width / target.width, height / target.height);
  return scale > 1.0 ? scale : undefined;
}
