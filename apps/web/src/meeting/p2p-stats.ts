import { apiNoContent } from '../api/client.js';
import type { ViewerSessionState } from './p2p-share-controller.js';
import type { ViewerP2pState } from './p2p-viewer-controller.js';
import type { WebRtcMediaStats, WebRtcStatsSnapshot } from './webrtc-stats.js';

/**
 * Anonymous P2P quality report. Must never contain media, SDP, IP, a real
 * identity, or the meeting id: the API hashes the meeting id server-side and
 * records only this payload plus `meetingIdHash` in an audit event.
 */
export interface P2pStatsReport {
  /** Anonymous id for this join session; never a participant identity. */
  sessionId: string;
  /** P2P establishment attempts (per viewer for the sharer, per offer for a viewer). */
  attempts: number;
  /** Sessions that reached the `p2p` state at least once. */
  p2pSucceeded: number;
  /** Sessions that moved to the LiveKit fallback path. */
  fallbacks: number;
  /** Average negotiating -> p2p duration in milliseconds (0 when none). */
  avgSetupMs: number;
  /** Average round-trip time over the meeting's stats samples (0 when none). */
  avgRttMs: number;
  /** Maximum packet-loss percentage over the meeting's stats samples (0 when none). */
  maxLossPct: number;
}

export interface P2pStatsCollectorDependencies {
  slug: string;
  /** Anonymous join-session id; defaults to a fresh `crypto.randomUUID()`. */
  sessionId?: string;
  /** Test seam: transport, defaults to `POST /api/v1/meetings/:slug/p2p-stats`. */
  sendReport?: (report: P2pStatsReport) => Promise<void>;
  /** Test seam: clock. */
  now?: () => number;
}

/**
 * Collects anonymous P2P quality statistics for one meeting-room session and
 * reports them once on leave / unmount. Both roles feed the same counters:
 * the sharer's per-viewer share sessions and the viewer's own P2P session.
 * Quality (RTT, loss) reuses the existing `webrtc-stats` snapshot source.
 */
export class P2pStatsCollector {
  private readonly sendReport: (report: P2pStatsReport) => Promise<void>;
  private readonly now: () => number;
  private readonly sessionId: string;
  private attempts = 0;
  private succeeded = 0;
  private fallbacks = 0;
  private setupTotalMs = 0;
  private setupCount = 0;
  private rttTotalMs = 0;
  private rttCount = 0;
  private maxLossPct = 0;
  private reported = false;
  /**
   * Per-viewer share sessions (sharer role). `startedAt` is set while an
   * attempt is pending; `lastState` is the viewer's previous snapshot state
   * (used to edge-trigger the fallback counter — the controller re-emits the
   * whole viewer map on every state transition of any viewer, and
   * `livekit-fallback` persists until the viewer leaves or retries).
   */
  private readonly shareSessions = new Map<string, { startedAt?: number; lastState?: ViewerSessionState }>();
  private viewerStartedAt?: number;

  constructor(private readonly dependencies: P2pStatsCollectorDependencies) {
    this.sendReport = dependencies.sendReport ?? defaultSendReport(dependencies.slug);
    this.now = dependencies.now ?? Date.now;
    this.sessionId = dependencies.sessionId ?? newSessionId();
  }

  /**
   * Sharer role: observe the per-viewer share session states
   * (`negotiating -> p2p / livekit-fallback`). A viewer that re-attempts after
   * a fallback, or joins again after closing, counts as a fresh attempt.
   */
  observeShareStates(states: ReadonlyMap<string, ViewerSessionState>, at = this.now()): void {
    for (const [identity, state] of states) {
      const session = this.shareSessions.get(identity);
      if (state === 'negotiating') {
        if (session?.startedAt === undefined) {
          this.attempts++;
          this.shareSessions.set(identity, { startedAt: at, lastState: state });
          continue;
        }
      } else if (state === 'p2p') {
        if (session?.startedAt !== undefined) {
          this.succeeded++;
          this.addSetup(at - session.startedAt);
          session.startedAt = undefined;
        }
      } else if (state === 'livekit-fallback') {
        // Edge-triggered like the negotiating/p2p branches: a viewer that is
        // already in `livekit-fallback` must not be counted again on snapshots
        // emitted for other viewers' transitions.
        if (session?.lastState !== 'livekit-fallback') this.fallbacks++;
        if (session) session.startedAt = undefined;
      } else if (state === 'closed') {
        if (session) session.startedAt = undefined;
      }
      if (session) session.lastState = state;
      else this.shareSessions.set(identity, { lastState: state });
    }
  }

  /** Viewer role: observe the viewer's own P2P session state transitions. */
  observeViewerState(state: ViewerP2pState, at = this.now()): void {
    if (state === 'negotiating') {
      if (this.viewerStartedAt === undefined) {
        this.attempts++;
        this.viewerStartedAt = at;
      }
    } else if (state === 'p2p') {
      if (this.viewerStartedAt !== undefined) {
        this.succeeded++;
        this.addSetup(at - this.viewerStartedAt);
        this.viewerStartedAt = undefined;
      }
    } else if (state === 'livekit') {
      this.viewerStartedAt = undefined;
      this.fallbacks++;
    } else {
      this.viewerStartedAt = undefined; // idle: no session pending
    }
  }

  /**
   * Feeds one quality sample from the existing `webrtc-stats` snapshot source.
   * RTT is averaged over the meeting; loss is kept at its maximum.
   */
  observeQuality(snapshot: WebRtcStatsSnapshot): void {
    const rtt = snapshot.sender?.roundTripTimeMs ?? snapshot.receiver?.roundTripTimeMs;
    if (rtt !== undefined) {
      this.rttTotalMs += rtt;
      this.rttCount++;
    }
    const loss = lossPercent(snapshot.receiver) ?? lossPercent(snapshot.sender);
    if (loss !== undefined && loss > this.maxLossPct) this.maxLossPct = loss;
  }

  /** The anonymous payload that would be sent; also used by tests. */
  reportPayload(): P2pStatsReport {
    return {
      sessionId: this.sessionId,
      attempts: this.attempts,
      p2pSucceeded: this.succeeded,
      fallbacks: this.fallbacks,
      avgSetupMs: this.average(this.setupTotalMs, this.setupCount),
      avgRttMs: this.average(this.rttTotalMs, this.rttCount),
      maxLossPct: round(this.maxLossPct, 1)
    };
  }

  /**
   * Reports once per meeting-room session. Failures are silently ignored:
   * telemetry must never interrupt the meeting flow.
   */
  async report(): Promise<void> {
    if (this.reported) return;
    this.reported = true;
    try {
      await this.sendReport(this.reportPayload());
    } catch {
      // Best-effort reporting; never surface to the meeting UI.
    }
  }

  private addSetup(ms: number): void {
    this.setupTotalMs += ms;
    this.setupCount++;
  }

  private average(total: number, count: number): number {
    return count === 0 ? 0 : round(total / count, 1);
  }
}

export function createP2pStatsCollector(dependencies: P2pStatsCollectorDependencies): P2pStatsCollector {
  return new P2pStatsCollector(dependencies);
}

function lossPercent(stats: WebRtcMediaStats | undefined): number | undefined {
  if (!stats) return undefined;
  const lost = stats.packetsLost;
  const received = stats.packetsReceived;
  if (lost === undefined || received === undefined || lost + received <= 0) return undefined;
  return round(lost / (lost + received) * 100, 1);
}

function defaultSendReport(slug: string): (report: P2pStatsReport) => Promise<void> {
  return (report) => apiNoContent(`/meetings/${encodeURIComponent(slug)}/p2p-stats`, {
    method: 'POST',
    body: JSON.stringify(report)
  });
}

function newSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `p2p-${Math.random().toString(36).slice(2)}`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
