import {
  P2P_ICE_DISCONNECT_TIMEOUT_MS,
  P2P_ICE_NEGOTIATION_MAX_MS,
  P2P_ICE_NEGOTIATION_PROGRESS_TIMEOUT_MS,
  P2P_TOTAL_UPLINK_BUDGET_BPS,
  type P2pTurnProvider,
  type ScreenShareCodec
} from '@meeting/contracts';
import { Type } from '@sinclair/typebox';

import { apiRequest } from '../api/client.js';
import {
  iceConfigurationExpiresSoon,
  normalizeP2pIceServerConfiguration,
  type P2pIceServerConfiguration
} from './p2p-ice.js';
import {
  inspectP2pMediaHealth,
  inspectSenderVideoStats,
  type SenderVideoStats
} from './p2p-media-health.js';
import {
  computeCloudflareMaximumScale,
  updateCloudflareEncoding,
  type CloudflareEncodingState
} from './cloudflare-adaptive-encoding.js';
import type { Peer } from './p2p-signaling.js';

export type ViewerSessionState = 'negotiating' | 'p2p' | 'turn' | 'livekit-fallback' | 'closed';

/** Lower bound used only when the selected aggregate budget can afford it. */
export const P2P_VIEWER_BITRATE_FLOOR = 1_000_000;

/**
 * Non-Cloudflare sender-side pressure adaptation: when the encoder reports
 * `bandwidth` limitation (with a collapsed frame rate) for this many
 * consecutive samples, the session switches from the user's degradation
 * preference to `balanced` so motion stays smooth and the picture avoids
 * blocky quantization. Cloudflare relay sessions use the continuous controller
 * below instead. The fixed policy restores the user's preference after a
 * longer run of unconstrained samples.
 */
export const P2P_SENDER_PRESSURE_SAMPLE_LIMIT = 3;
export const P2P_SENDER_RECOVER_SAMPLE_LIMIT = 5;
/** Frame-rate collapse ratio that counts as "motion is starving" under a bandwidth limit. */
export const P2P_SENDER_FPS_PRESSURE_RATIO = 0.7;

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
  start(stream: MediaStream, options: P2pShareOptions, viewers: Peer[], recoverNegotiating?: boolean): Promise<void>;
  handleAnswer(from: string, sdp: string, generation?: string): Promise<void>;
  handleIce(from: string, candidate: string | null, generation?: string): Promise<void>;
  handleMediaReady(from: string, generation?: string): void;
  handleViewerLeft(identity: string): void;
  /** A viewer asked (via the retry button) for a fresh offer: rebuild their session. */
  handleRetry(from: string): void;
  /** The sharer asked to re-drive every viewer: fresh sessions for the whole roster. */
  retryAll(viewers: Peer[]): Promise<void>;
  stop(): Promise<void>;   // 关闭全部 PC，广播 bye
  getViewerStates(): ReadonlyMap<string, ViewerSessionState>;
  getViewerTurnProviders?(): ReadonlyMap<string, P2pTurnProvider>;
  /** Supplies the latest independent Cloudflare edge upload measurement. */
  setCloudflareUplinkEstimate?(bitrateBps: number): void;
  getEffectiveUplinkEstimateBps?(): number | undefined;
  refreshIceServers?(configuration: P2pIceServerConfiguration): void;
  getStatsReports(): Promise<RTCStatsReport[]>;
  subscribe(listener: (states: ReadonlyMap<string, ViewerSessionState>) => void): () => void;
}

/**
 * Minimal signaling surface the controller needs. `P2pSignalingClient` satisfies
 * it structurally, so tests can inject a fake without a WebSocket.
 */
export interface P2pShareSignaling {
  sendOffer(to: string, sdp: string, generation?: string, turnProvider?: P2pTurnProvider): void;
  sendIce(to: string, candidate: string | null, generation?: string): void;
  sendBye(to: string, reason?: string): void;
}

export interface P2pShareControllerDependencies {
  slug: string;
  signaling: P2pShareSignaling;
  /** PC factory; defaults to `window.RTCPeerConnection` with the fetched ICE servers. */
  createPeerConnection?: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  /** ICE credentials; defaults to `GET /api/v1/meetings/:slug/ice-servers`. */
  fetchIceServers?: () => Promise<RTCIceServer[] | P2pIceServerConfiguration>;
  /** Fired once per viewer that moves to `livekit-fallback` (the caller publishes the LiveKit screen track). */
  onViewerFallback?: (identity: string) => void;
  /** Fired when every tracked viewer has left (`closed`); the caller may then stop the whole share. */
  onAllViewersClosed?: () => void;
  /** Injectable scheduler used by tests; production samples the selected ICE pair once per second. */
  scheduleTransportChecks?: (check: () => Promise<void>, intervalMs: number) => () => void;
  /** Monotonic clock (ms); defaults to `Date.now`. Injectable for deadline tests. */
  now?: () => number;
}

export const IceServersResponseSchema = Type.Object({
  iceServers: Type.Array(Type.Object({
    urls: Type.Array(Type.String()),
    username: Type.Optional(Type.String()),
    credential: Type.Optional(Type.String())
  })),
  availableTurnProviders: Type.Optional(Type.Array(Type.Union([
    Type.Literal('coturn'),
    Type.Literal('cloudflare')
  ]))),
  turnProvider: Type.Optional(Type.Union([Type.Literal('coturn'), Type.Literal('cloudflare')])),
  turnCredentialsExpiresAt: Type.Optional(Type.Integer())
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
  generation: string;
  pc: RTCPeerConnection;
  turnProvider: P2pTurnProvider;
  videoSender?: RTCRtpSender;
  options: P2pShareOptions;
  state: ViewerSessionState;
  queuedCandidates: Array<RTCIceCandidateInit | undefined>;
  queuedLocalCandidates: Array<string | null>;
  pendingOffer: boolean;
  offerSent: boolean;
  pcClosed: boolean;
  transportConnected: boolean;
  mediaReadyReceived: boolean;
  mediaReadyConfirmed: boolean;
  senderParameterTail: Promise<void>;
  transportSampleTail: Promise<void>;
  stopTransportMonitor?: () => void;
  negotiationTimer?: ReturnType<typeof setTimeout>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  /** First-offer timestamp of this negotiation; caps progress extensions and the auto retry. */
  negotiationStartedAt: number;
  /** One bounded automatic re-drive with fresh ICE credentials before falling back. */
  autoRetried: boolean;
  /** Sender is in pressure mode: encoding uses `balanced` instead of the user's preference. */
  degradationRelaxed: boolean;
  bandwidthLimitedSamples: number;
  recoveredSamples: number;
  /** Keeps non-Cloudflare P2P/TURN sessions from staying on a tiny browser layer. */
  resolutionProtected: boolean;
  /** Smoothed per-connection Cloudflare relay encoding state. */
  cloudflareEncodingState?: CloudflareEncodingState;
  /** Smoothed per-connection P2P / direct encoding state for dynamic resolution scaling. */
  p2pEncodingState?: CloudflareEncodingState;
  /** Previous outbound sample used to derive the actual video bitrate. */
  lastSenderBytesSent?: number;
  lastSenderStatsTimestamp?: number;
}

class P2pShareControllerImpl implements P2pShareController {
  private readonly createPeerConnection: (iceServers: RTCIceServer[]) => RTCPeerConnection;
  private readonly fetchIceServers: () => Promise<RTCIceServer[] | P2pIceServerConfiguration>;
  private readonly scheduleTransportChecks: (check: () => Promise<void>, intervalMs: number) => () => void;
  private readonly nowMs: () => number;
  private readonly sessions = new Map<string, ViewerSession>();
  private readonly listeners = new Set<(states: ReadonlyMap<string, ViewerSessionState>) => void>();
  private iceConfiguration?: P2pIceServerConfiguration;
  private iceRefreshTimer?: ReturnType<typeof setTimeout>;
  /** The captured share the sessions publish; kept for retry re-drives. */
  private activeStream?: MediaStream;
  /** The selected per-viewer P2P tier; the aggregate of all session caps stays under the uplink budget. */
  private activeOptions?: P2pShareOptions;
  private cloudflareUplinkEstimateBps?: number;
  private nextGeneration = 0;
  private nextRetryToken = 0;
  private readonly pendingRetryTokens = new Map<string, number>();

  constructor(private readonly deps: P2pShareControllerDependencies) {
    this.createPeerConnection = deps.createPeerConnection
      ?? ((servers) => new RTCPeerConnection({ iceServers: servers }));
    this.fetchIceServers = deps.fetchIceServers ?? defaultFetchIceServers(deps.slug);
    this.scheduleTransportChecks = deps.scheduleTransportChecks ?? ((check, intervalMs) => {
      const timer = setInterval(() => { void check(); }, intervalMs);
      return () => clearInterval(timer);
    });
    this.nowMs = deps.now ?? Date.now;
  }

  async start(
    stream: MediaStream,
    options: P2pShareOptions,
    viewers: Peer[],
    recoverNegotiating = false
  ): Promise<void> {
    this.activeStream = stream;
    this.activeOptions = options;
    const iceConfiguration = await this.resolveIceServers(recoverNegotiating);
    const sessionsToEstablish: ViewerSession[] = [];
    for (const viewer of viewers) {
      const existing = this.sessions.get(viewer.identity);
      // A viewer that left and rejoined starts a fresh session; p2p/fallback sessions keep running.
      if (existing && existing.state !== 'closed'
        && !(recoverNegotiating && existing.state === 'negotiating')) continue;
      if (existing) this.closeSession(existing);
      this.pendingRetryTokens.delete(viewer.identity);
      const session = this.createSession(viewer.identity, stream, options, iceConfiguration);
      sessionsToEstablish.push(session);
    }
    this.emit();
    await this.rebalanceBitrates();
    const establishes = sessionsToEstablish.map((session) => this.establishSession(session));
    // Existing negotiations are not re-offered here. The signaling client
    // retains their offer/candidates across a temporary socket outage; making
    // another offer on the same PC would mix two trickle-ICE transactions.
    await Promise.all(establishes);
  }

  async handleAnswer(from: string, sdp: string, generation?: string): Promise<void> {
    const session = this.sessions.get(from);
    if (!session || session.state !== 'negotiating') return;
    if (generation !== undefined && generation !== session.generation) return;
    try {
      await session.pc.setRemoteDescription({ type: 'answer', sdp });
      await this.flushCandidates(session);
    } catch {
      this.fallback(session);
    }
  }

  async handleIce(from: string, candidate: string | null, generation?: string): Promise<void> {
    const session = this.sessions.get(from);
    if (!session || (session.state !== 'negotiating' && session.state !== 'p2p' && session.state !== 'turn')) return;
    if (generation !== undefined && generation !== session.generation) return;
    const init = candidate === null ? undefined : deserializeIceCandidate(candidate);
    if (session.pc.remoteDescription === null) {
      session.queuedCandidates.push(init);
    } else {
      await this.applyCandidate(session, init);
    }
  }

  handleMediaReady(from: string, generation?: string): void {
    const session = this.sessions.get(from);
    if (!session || session.state !== 'negotiating') return;
    if (generation !== undefined && generation !== session.generation) return;
    session.mediaReadyReceived = true;
    this.confirmMediaReady(session);
  }

  private confirmMediaReady(session: ViewerSession): void {
    if (!session.transportConnected || !session.mediaReadyReceived || session.mediaReadyConfirmed) return;
    session.mediaReadyConfirmed = true;
    this.clearTimers(session);
    this.armTransportMonitor(session);
    void this.queueTransportStateUpdate(session);
  }

  handleViewerLeft(identity: string): void {
    this.pendingRetryTokens.delete(identity);
    const session = this.sessions.get(identity);
    if (!session) return;
    if (session.state !== 'closed') {
      this.clearTimers(session);
      this.closePc(session);
      this.transition(session, 'closed');
      if (this.allViewersClosed()) this.deps.onAllViewersClosed?.();
    }
  }

  handleRetry(from: string): void {
    if (this.activeStream === undefined || this.activeOptions === undefined) return;
    const existing = this.sessions.get(from);
    if (existing) this.closeSession(existing);
    const retryToken = ++this.nextRetryToken;
    this.pendingRetryTokens.set(from, retryToken);
    // A fresh PC and offer: the viewer rebuilds its session on the new offer,
    // so stale candidates from a failed attempt can never poison the retry.
    void this.retryViewer(from, retryToken);
  }

  private async retryViewer(from: string, retryToken: number): Promise<void> {
    const iceConfiguration = await this.resolveIceServers(true).catch(() => undefined);
    if (this.pendingRetryTokens.get(from) !== retryToken) return;
    this.pendingRetryTokens.delete(from);
    // The share may have stopped while the credentials were in flight.
    if (iceConfiguration === undefined || this.activeStream === undefined || this.activeOptions === undefined) return;
    const current = this.sessions.get(from);
    if (current) this.closeSession(current);
    const session = this.createSession(from, this.activeStream, this.activeOptions, iceConfiguration);
    await this.rebalanceBitrates();
    await this.establishSession(session);
  }

  async retryAll(viewers: Peer[]): Promise<void> {
    if (this.activeStream === undefined || this.activeOptions === undefined) return;
    this.pendingRetryTokens.clear();
    const iceConfiguration = await this.resolveIceServers(true);
    for (const session of this.sessions.values()) {
      if (session.state !== 'closed') {
        this.clearTimers(session);
        this.closePc(session);
      }
    }
    this.sessions.clear();
    const sessionsToEstablish: ViewerSession[] = [];
    for (const viewer of viewers) {
      const session = this.createSession(viewer.identity, this.activeStream, this.activeOptions, iceConfiguration);
      sessionsToEstablish.push(session);
    }
    this.emit();
    await this.rebalanceBitrates();
    const establishes = sessionsToEstablish.map((session) => this.establishSession(session));
    await Promise.all(establishes);
  }

  async stop(): Promise<void> {
    if (this.iceRefreshTimer !== undefined) clearTimeout(this.iceRefreshTimer);
    this.iceRefreshTimer = undefined;
    this.activeStream = undefined;
    this.activeOptions = undefined;
    this.cloudflareUplinkEstimateBps = undefined;
    this.pendingRetryTokens.clear();
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

  getViewerTurnProviders(): ReadonlyMap<string, P2pTurnProvider> {
    const snapshot = new Map<string, P2pTurnProvider>();
    for (const [identity, session] of this.sessions) {
      if (session.state === 'turn') snapshot.set(identity, session.turnProvider);
    }
    return snapshot;
  }

  setCloudflareUplinkEstimate(bitrateBps: number): void {
    if (!Number.isFinite(bitrateBps) || bitrateBps <= 0) return;
    this.cloudflareUplinkEstimateBps = bitrateBps;
  }

  getEffectiveUplinkEstimateBps(): number | undefined {
    let maxRtcBitrate = 0;
    for (const session of this.sessions.values()) {
      if (session.pcClosed) continue;
      const cfState = session.cloudflareEncodingState;
      if (cfState?.trustedAvailableOutgoingBitrateBps) {
        maxRtcBitrate = Math.max(maxRtcBitrate, cfState.trustedAvailableOutgoingBitrateBps);
      }
      if (cfState?.bandwidthEstimateBps) {
        maxRtcBitrate = Math.max(maxRtcBitrate, cfState.bandwidthEstimateBps);
      }
      if (cfState?.targetBitrateBps) {
        maxRtcBitrate = Math.max(maxRtcBitrate, cfState.targetBitrateBps);
      }
    }
    const estimate = Math.max(this.cloudflareUplinkEstimateBps ?? 0, maxRtcBitrate);
    return estimate > 0 ? estimate : undefined;
  }

  refreshIceServers(configuration: P2pIceServerConfiguration): void {
    this.iceConfiguration = configuration;
    for (const session of this.sessions.values()) {
      if (session.pcClosed) continue;
      if (session.state !== 'turn') session.turnProvider = configuration.turnProvider;
      try {
        session.pc.setConfiguration({ iceServers: configuration.iceServers });
      } catch {
        // A session may be closing while credentials refresh; its next retry
        // will use the refreshed configuration.
      }
    }
    this.armIceRefresh(configuration);
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

  private async resolveIceServers(forceRefresh = false): Promise<P2pIceServerConfiguration> {
    if (forceRefresh) this.iceConfiguration = undefined;
    else if (this.iceConfiguration !== undefined
      && iceConfigurationExpiresSoon(this.iceConfiguration, this.nowMs() / 1_000)) {
      // The cached TURN credentials are about to expire: a session built on
      // them would silently gather no relay candidates. Refresh before use.
      this.iceConfiguration = undefined;
    }
    if (this.iceConfiguration === undefined) {
      this.refreshIceServers(normalizeP2pIceServerConfiguration(await this.fetchIceServers()));
    }
    return this.iceConfiguration!;
  }

  private armIceRefresh(configuration: P2pIceServerConfiguration): void {
    if (this.iceRefreshTimer !== undefined) clearTimeout(this.iceRefreshTimer);
    this.iceRefreshTimer = undefined;
    if (configuration.turnCredentialsExpiresAt === undefined) return;
    const delay = Math.max(1_000, (configuration.turnCredentialsExpiresAt - this.nowMs() / 1_000 - 60) * 1_000);
    this.iceRefreshTimer = setTimeout(() => {
      this.iceRefreshTimer = undefined;
      void this.refreshIceServersFromProvider();
    }, delay);
  }

  private async refreshIceServersFromProvider(): Promise<void> {
    if (this.activeStream === undefined || this.activeOptions === undefined) return;
    try {
      this.refreshIceServers(normalizeP2pIceServerConfiguration(await this.fetchIceServers()));
    } catch {
      // A transient provider outage must not tear down a healthy session. Try
      // again shortly; existing coturn/Cloudflare allocations keep flowing.
      this.iceRefreshTimer = setTimeout(() => {
        this.iceRefreshTimer = undefined;
        void this.refreshIceServersFromProvider();
      }, 2_000);
    }
  }

  private createSession(
    identity: string,
    stream: MediaStream,
    options: P2pShareOptions,
    iceConfiguration: P2pIceServerConfiguration
  ): ViewerSession {
    const pc = this.createPeerConnection(iceConfiguration.iceServers);
    const session: ViewerSession = {
      identity,
      generation: `share-${Date.now()}-${++this.nextGeneration}`,
      pc,
      turnProvider: iceConfiguration.turnProvider,
      options,
      state: 'negotiating',
      queuedCandidates: [],
      queuedLocalCandidates: [],
      pendingOffer: false,
      offerSent: false,
      pcClosed: false,
      transportConnected: false,
      mediaReadyReceived: false,
      mediaReadyConfirmed: false,
      senderParameterTail: Promise.resolve(),
      transportSampleTail: Promise.resolve(),
      negotiationStartedAt: 0,
      autoRetried: false,
      degradationRelaxed: false,
      bandwidthLimitedSamples: 0,
      recoveredSamples: 0,
      resolutionProtected: false
    };
    for (const track of stream.getVideoTracks().slice(0, 1)) {
      // A transceiver (not `addTrack`) so we can set codec preferences before
      // the offer is created; the bitrate/frame-rate cap is applied later via
      // `setParameters` so a failure there stays best-effort.
      const transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
      applyCodecPreference(transceiver, options.codec);
      session.videoSender = transceiver.sender;
    }
    for (const track of stream.getAudioTracks().slice(0, 1)) {
      pc.addTrack(track, stream);
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
        await this.applySenderParameters(session);
      }
      const offer = await session.pc.createOffer();
      await session.pc.setLocalDescription(offer);
      if (session.state === 'closed' || session.state === 'livekit-fallback') return; // left or fell back mid-establish
      if (offer.sdp === undefined) throw new Error('createOffer returned no SDP');
      this.deps.signaling.sendOffer(session.identity, offer.sdp, session.generation, session.turnProvider);
      session.offerSent = true;
      this.flushLocalCandidates(session);
      this.armNegotiationTimer(session);
    } catch {
      this.fallback(session);
    } finally {
      session.pendingOffer = false;
    }
  }

  private handleLocalCandidate(session: ViewerSession, event: RTCPeerConnectionIceEvent): void {
    if (session.state === 'closed' || session.state === 'livekit-fallback') return;
    const candidate = event.candidate ? serializeIceCandidate(event.candidate) : null;
    if (!session.offerSent) {
      session.queuedLocalCandidates.push(candidate);
      return;
    }
    this.deps.signaling.sendIce(session.identity, candidate, session.generation);
  }

  private flushLocalCandidates(session: ViewerSession): void {
    const queued = session.queuedLocalCandidates.splice(0);
    for (const candidate of queued) this.deps.signaling.sendIce(session.identity, candidate, session.generation);
  }

  private handleIceConnectionState(session: ViewerSession): void {
    if (session.state === 'closed' || session.state === 'livekit-fallback') return;
    const state = session.pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      session.transportConnected = true;
      this.clearDisconnectTimer(session);
      this.confirmMediaReady(session);
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
    } else if (state === 'checking') {
      // A live candidate-pair check is real progress: a slow-but-viable path
      // (fresh relay allocation, asymmetric NAT re-check) gets more time
      // instead of being killed by the fixed first-offer deadline.
      if (session.state === 'negotiating') this.armNegotiationTimer(session);
    } else if (state === 'closed') {
      this.clearTimers(session);
    }
  }

  /**
   * Arms the negotiation deadline. Every ICE progress event (`checking`)
   * re-arms it for `P2P_ICE_NEGOTIATION_PROGRESS_TIMEOUT_MS` from now, but the
   * deadline never moves past `P2P_ICE_NEGOTIATION_MAX_MS` after the first
   * offer — a permanently stuck session still terminates.
   */
  private armNegotiationTimer(session: ViewerSession): void {
    this.clearNegotiationTimer(session);
    const now = this.nowMs();
    if (session.negotiationStartedAt === 0) session.negotiationStartedAt = now;
    const deadline = Math.min(
      session.negotiationStartedAt + P2P_ICE_NEGOTIATION_MAX_MS,
      now + P2P_ICE_NEGOTIATION_PROGRESS_TIMEOUT_MS
    );
    const delay = Math.max(0, deadline - now);
    session.negotiationTimer = setTimeout(() => {
      session.negotiationTimer = undefined;
      if (session.state === 'negotiating') void this.handleNegotiationTimeout(session);
    }, delay);
  }

  /**
   * The negotiation outlived its deadline. Before permanently falling back,
   * the session gets exactly one automatic re-drive with a fresh PC and fresh
   * ICE credentials: expired TURN credentials or a transient first-attempt
   * failure otherwise strand an asymmetric connection (A→B direct works while
   * B→A does not) on the SFU forever.
   */
  private async handleNegotiationTimeout(session: ViewerSession): Promise<void> {
    if (session.state !== 'negotiating') return;
    if (session.autoRetried) {
      this.fallback(session);
      return;
    }
    session.autoRetried = true;
    if (this.activeStream === undefined || this.activeOptions === undefined) {
      this.fallback(session);
      return;
    }
    const iceConfiguration = await this.resolveIceServers(true).catch(() => undefined);
    // The viewer left, the share stopped, or a retry already replaced this
    // session while the credential refresh was in flight.
    if (this.sessions.get(session.identity) !== session || session.state !== 'negotiating') return;
    if (iceConfiguration === undefined) {
      this.fallback(session);
      return;
    }
    // Replace the stalled session with a fresh PC, fresh credentials and a
    // fresh offer generation; the viewer treats the offer as a renegotiation.
    this.closeSession(session);
    const replacement = this.createSession(session.identity, this.activeStream, this.activeOptions, iceConfiguration);
    replacement.autoRetried = true;
    await this.rebalanceBitrates();
    await this.establishSession(replacement);
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
      const report = await session.pc.getStats();
      if (this.sessions.get(session.identity) !== session || session.pcClosed) return;
      const health = inspectP2pMediaHealth(report);
      if ((session.state === 'negotiating' || session.state === 'p2p' || session.state === 'turn')
        && health.path !== 'unknown') {
        const classifiedState: ViewerSessionState = health.path === 'relay' ? 'turn' : 'p2p';
        if (classifiedState !== session.state) this.transition(session, classifiedState);
      }
      await this.adaptEncodingPressure(session, inspectSenderVideoStats(report));
    } catch {
      // Candidate-pair stats may be briefly unavailable after media-ready.
      // The usable session remains active and later UI stats can classify it.
    }
  }

  /**
   * Watches the sender's encoder limitation and switches this session between
   * the user's degradation preference and `balanced`:
   * - sustained `bandwidth` limitation with a collapsed frame rate (the exact
   *   "stable 1080p but ~10 fps under motion" failure) relaxes to `balanced`,
   *   which sheds resolution before quantization blows up into blocks/blur;
   * - a longer run of unconstrained samples restores the user's preference.
   */
  private async adaptEncodingPressure(session: ViewerSession, sender: SenderVideoStats): Promise<void> {
    if (this.sessions.get(session.identity) !== session || session.pcClosed) return;
    if (session.state !== 'p2p' && session.state !== 'turn') return;
    if (session.state === 'turn' && session.turnProvider === 'cloudflare') {
      await this.adaptCloudflareEncoding(session, sender);
      const isCollapsed = this.hasCollapsedResolution(session, sender);
      if (isCollapsed && !session.resolutionProtected) {
        session.resolutionProtected = true;
        await this.applySenderParameters(session);
      } else if (!isCollapsed && session.resolutionProtected) {
        session.resolutionProtected = false;
        await this.applySenderParameters(session);
      }
      return;
    }

    const isCollapsed = this.hasCollapsedResolution(session, sender);
    if (isCollapsed) {
      if (!session.resolutionProtected) {
        session.resolutionProtected = true;
        await this.applySenderParameters(session);
      }
      return;
    } else if (session.resolutionProtected) {
      session.resolutionProtected = false;
      await this.applySenderParameters(session);
    }

    const bandwidthLimited = sender.qualityLimitationReason === 'bandwidth';
    const fpsCollapsed = sender.framesPerSecond !== undefined
      && session.options.frameRate > 0
      && sender.framesPerSecond < session.options.frameRate * P2P_SENDER_FPS_PRESSURE_RATIO;
    if (session.degradationRelaxed) {
      if (bandwidthLimited) {
        session.recoveredSamples = 0;
      } else {
        session.recoveredSamples += 1;
        if (session.recoveredSamples >= P2P_SENDER_RECOVER_SAMPLE_LIMIT) {
          session.degradationRelaxed = false;
          await this.applySenderParameters(session);
        }
      }
    } else if (bandwidthLimited && (fpsCollapsed || sender.framesPerSecond === undefined)) {
      session.bandwidthLimitedSamples += 1;
      if (session.bandwidthLimitedSamples >= P2P_SENDER_PRESSURE_SAMPLE_LIMIT) {
        session.degradationRelaxed = true;
        await this.applySenderParameters(session);
      }
    } else {
      session.bandwidthLimitedSamples = 0;
    }

    // Dynamically adjust sampling rate for P2P / coturn sessions to maintain frame rate
    await this.adaptP2pEncoding(session, sender);
  }

  /**
   * Direct P2P and coturn sessions dynamically adjust resolution sampling scale
   * (scaleResolutionDownBy) to preserve target frame rate when bandwidth pressure
   * occurs, without artificially lowering the maxBitrate cap or causing low-bitrate lock-in.
   */
  private async adaptP2pEncoding(session: ViewerSession, sender: SenderVideoStats): Promise<void> {
    const actualOutgoingBitrateBps = this.sampleActualOutgoingBitrate(session, sender);
    const sourceSettings = session.videoSender?.track?.getSettings?.() ?? {};
    const minimumScaleResolutionDownBy = computeResolutionScale(sourceSettings) ?? 1;
    const maximumScaleResolutionDownBy = computeCloudflareMaximumScale(sourceSettings);
    const referenceBitrateBps = session.options.maxBitrate;
    const previous = session.p2pEncodingState ?? {
      targetBitrateBps: session.options.maxBitrate,
      scaleResolutionDownBy: minimumScaleResolutionDownBy
    };
    const next = updateCloudflareEncoding({
      previous,
      measurement: {
        availableOutgoingBitrateBps: sender.availableOutgoingBitrateBps,
        actualOutgoingBitrateBps,
        qualityLimitationReason: sender.qualityLimitationReason,
        framesPerSecond: sender.framesPerSecond,
        targetFrameRate: session.options.frameRate
      },
      minimumScaleResolutionDownBy,
      maximumScaleResolutionDownBy,
      referenceBitrateBps
    });
    if (next === previous) return;
    const encodingChanged = next.scaleResolutionDownBy !== previous.scaleResolutionDownBy;
    session.p2pEncodingState = next;
    if (encodingChanged) await this.applySenderParameters(session);
  }

  /**
   * Cloudflare relay sessions are controlled per connection. The relay's
   * independent Cloudflare upload test seeds the target. The RTC estimate is
   * diagnostic only; actual RTP rate, frame rate and encoder limitation decide
   * whether probing is healthy or genuinely congested.
   */
  private async adaptCloudflareEncoding(session: ViewerSession, sender: SenderVideoStats): Promise<void> {
    const actualOutgoingBitrateBps = this.sampleActualOutgoingBitrate(session, sender);
    const sourceSettings = session.videoSender?.track?.getSettings?.() ?? {};
    const minimumScaleResolutionDownBy = computeResolutionScale(sourceSettings) ?? 1;
    const maximumScaleResolutionDownBy = computeCloudflareMaximumScale(sourceSettings);
    const referenceBitrateBps = Math.max(
      session.options.maxBitrate,
      session.options.frameRate >= 60 ? 15_000_000 : 8_000_000
    );
    const previous = session.cloudflareEncodingState ?? {
      targetBitrateBps: session.options.maxBitrate,
      scaleResolutionDownBy: minimumScaleResolutionDownBy
    };
    const next = updateCloudflareEncoding({
      previous,
      measurement: {
        availableOutgoingBitrateBps: sender.availableOutgoingBitrateBps,
        actualOutgoingBitrateBps,
        testedCloudflareUplinkBitrateBps: this.cloudflareUplinkEstimateBps,
        qualityLimitationReason: sender.qualityLimitationReason,
        framesPerSecond: sender.framesPerSecond,
        targetFrameRate: session.options.frameRate
      },
      minimumScaleResolutionDownBy,
      maximumScaleResolutionDownBy,
      referenceBitrateBps
    });
    if (next === previous) return;
    const encodingChanged = next.targetBitrateBps !== previous.targetBitrateBps
      || next.scaleResolutionDownBy !== previous.scaleResolutionDownBy;
    session.cloudflareEncodingState = next;
    if (encodingChanged) await this.applySenderParameters(session);
  }

  private sampleActualOutgoingBitrate(session: ViewerSession, sender: SenderVideoStats): number | undefined {
    const bytesSent = sender.bytesSent;
    const timestamp = sender.timestamp;
    const previousBytes = session.lastSenderBytesSent;
    const previousTimestamp = session.lastSenderStatsTimestamp;
    session.lastSenderBytesSent = bytesSent;
    session.lastSenderStatsTimestamp = timestamp;
    if (bytesSent === undefined || timestamp === undefined
      || previousBytes === undefined || previousTimestamp === undefined
      || timestamp <= previousTimestamp || bytesSent < previousBytes) return undefined;
    const elapsedSeconds = (timestamp - previousTimestamp) / 1_000;
    return elapsedSeconds > 0 ? (bytesSent - previousBytes) * 8 / elapsedSeconds : undefined;
  }

  private hasCollapsedResolution(session: ViewerSession, sender: SenderVideoStats): boolean {
    const sourceSettings = session.videoSender?.track?.getSettings?.() ?? {};
    const sourceWidth = sourceSettings.width;
    const sourceHeight = sourceSettings.height;
    const outputWidth = sender.frameWidth;
    const outputHeight = sender.frameHeight;
    if (sourceWidth === undefined || sourceHeight === undefined
      || outputWidth === undefined || outputHeight === undefined
      || sourceWidth <= 0 || sourceHeight <= 0 || outputWidth <= 0 || outputHeight <= 0) return false;
    const minimumSourceShortSide = Math.min(720, Math.min(sourceWidth, sourceHeight));
    return Math.min(outputWidth, outputHeight) < minimumSourceShortSide * 0.8;
  }

  /** Applies this active viewer's fair share without disturbing other sessions. */
  private async applySenderParameters(session: ViewerSession): Promise<void> {
    session.senderParameterTail = session.senderParameterTail.then(async () => {
      if (session.videoSender === undefined || session.pcClosed) return;
      try {
        const { options } = session;
        const cloudflareAdaptive = session.state === 'turn'
          && session.turnProvider === 'cloudflare'
          && session.cloudflareEncodingState !== undefined;
        const p2pAdaptive = (session.state === 'p2p' || (session.state === 'turn' && session.turnProvider !== 'cloudflare'))
          && session.p2pEncodingState !== undefined;
        const baseScale = computeResolutionScale(session.videoSender.track?.getSettings?.() ?? {});
        const scale = cloudflareAdaptive
          ? session.cloudflareEncodingState!.scaleResolutionDownBy
          : p2pAdaptive
            ? session.p2pEncodingState!.scaleResolutionDownBy
            : baseScale;
        const isActivelyDownscaled = scale !== undefined && (baseScale === undefined ? scale > 1.05 : scale > baseScale * 1.05);
        await session.videoSender.setParameters({
          ...session.videoSender.getParameters(),
          encodings: [{
            maxBitrate: cloudflareAdaptive
              ? session.cloudflareEncodingState!.targetBitrateBps
              : options.maxBitrate,
            maxFramerate: options.frameRate,
            ...(scale === undefined ? {} : { scaleResolutionDownBy: scale })
          }],
          degradationPreference: session.resolutionProtected
            ? 'maintain-resolution'
            : (cloudflareAdaptive || isActivelyDownscaled)
              ? 'maintain-framerate'
              : session.degradationRelaxed
                ? pressureDegradationPreference(options.degradationPreference)
                : options.degradationPreference
        });
      } catch {
        // Bitrate tuning is best-effort; a failure must not kill the session or
        // poison the tail, so a later rebalance can retry with fresh parameters.
      }
    });
    await session.senderParameterTail;
  }

  private armTransportMonitor(session: ViewerSession): void {
    session.stopTransportMonitor?.();
    session.stopTransportMonitor = this.scheduleTransportChecks(
      () => this.queueTransportStateUpdate(session),
      1_000
    );
  }

  private async queueTransportStateUpdate(session: ViewerSession): Promise<void> {
    session.transportSampleTail = session.transportSampleTail
      .then(() => this.updateTransportState(session))
      .catch(() => undefined);
    await session.transportSampleTail;
  }

  /**
   * Allocates the per-viewer encoding cap for direct, coturn and negotiating
   * sessions. Cloudflare relay sessions are deliberately excluded: their
   * per-connection controller follows the relay estimate and the selected
   * Cloudflare policy explicitly accepts aggregate uplink contention.
   */
  private async rebalanceBitrates(): Promise<void> {
    const selected = this.activeOptions;
    if (selected === undefined) return;
    const active = [...this.sessions.values()].filter((session) => !session.pcClosed
      && (session.state === 'negotiating' || session.state === 'p2p' || session.state === 'turn'));
    if (active.length === 0) return;
    const budgeted = active.filter((session) => !(session.state === 'turn' && session.turnProvider === 'cloudflare'));
    const fairShare = Math.floor(P2P_TOTAL_UPLINK_BUDGET_BPS / Math.max(1, budgeted.length));
    const perViewer = Math.min(selected.maxBitrate, fairShare);
    const maxBitrate = selected.maxBitrate >= P2P_VIEWER_BITRATE_FLOOR * Math.max(1, budgeted.length)
      ? Math.max(P2P_VIEWER_BITRATE_FLOOR, perViewer)
      : perViewer;
    await Promise.all(budgeted.map(async (session) => {
      session.options = { ...selected, maxBitrate };
      await this.applySenderParameters(session);
    }));
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
    session.stopTransportMonitor?.();
    session.stopTransportMonitor = undefined;
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
    void this.rebalanceBitrates();
  }

  private allViewersClosed(): boolean {
    return this.sessions.size > 0 && [...this.sessions.values()].every((session) => session.state === 'closed');
  }

  private emit(): void {
    const snapshot = this.getViewerStates();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function pressureDegradationPreference(
  preference: RTCDegradationPreference
): RTCDegradationPreference {
  return preference === 'maintain-framerate' ? 'maintain-framerate' : 'balanced';
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
  const preferred = capabilities
    .filter((codecCapability) => codecCapability.mimeType.toLowerCase() === wanted)
    .concat(capabilities.filter((codecCapability) => codecCapability.mimeType.toLowerCase() !== wanted));
  if (preferred.length > 0) transceiver.setCodecPreferences(preferred);
}

function defaultFetchIceServers(slug: string): () => Promise<P2pIceServerConfiguration> {
  return async () => {
    const response = await apiRequest<P2pIceServerConfiguration>(
      `/meetings/${encodeURIComponent(slug)}/ice-servers`,
      IceServersResponseSchema
    );
    return response;
  };
}

export function createP2pShareController(dependencies: P2pShareControllerDependencies): P2pShareController {
  return new P2pShareControllerImpl(dependencies);
}

/**
 * Computes an aspect-preserving `scaleResolutionDownBy` for a captured track.
 * The tier is selected by the source's shorter side, so 4:3 and portrait
 * captures can still use the 1080p tier when they have enough detail. The
 * target is an orientation-aware bounding box and the larger fit ratio is used
 * so neither output dimension exceeds that box. A source below 720p is kept
 * native; the helper never upscales.
 */
export function computeResolutionScale(settings: { width?: number; height?: number }): number | undefined {
  const width = settings.width;
  const height = settings.height;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;

  const shortSide = Math.min(width, height);
  const target = shortSide >= 1080
    ? { long: 1920, short: 1080 }
    : shortSide >= 720
      ? { long: 1280, short: 720 }
      : undefined;
  if (target === undefined) return undefined;

  const landscape = width >= height;
  const targetWidth = landscape ? target.long : target.short;
  const targetHeight = landscape ? target.short : target.long;
  const scale = Math.max(width / targetWidth, height / targetHeight);
  return scale > 1.0 ? scale : undefined;
}
