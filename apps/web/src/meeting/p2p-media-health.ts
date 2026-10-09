export type P2pTransportPath = 'direct' | 'relay' | 'unknown';

export interface P2pMediaHealth {
  path: P2pTransportPath;
  bytesReceived: number;
  framesDecoded: number;
  packetsReceived: number;
  packetsLost: number;
  freezeCount: number;
}

/** Sender-side encoder telemetry used for degradation adaptation. */
export interface SenderVideoStats {
  qualityLimitationReason?: string;
  framesPerSecond?: number;
  frameWidth?: number;
  frameHeight?: number;
  availableOutgoingBitrateBps?: number;
  /** Encoder-reported instantaneous target bitrate; read-only evidence. */
  encoderTargetBitrateBps?: number;
  /** Frames the ICE layer dropped on send; growth signals real send pressure. */
  packetsDiscardedOnSend?: number;
  roundTripTimeMs?: number;
  remotePacketsLost?: number;
  remotePacketsReceived?: number;
  selectedLocalCandidateType?: string;
  selectedLocalCandidateUrl?: string;
  selectedRelayProtocol?: string;
  bytesSent?: number;
  timestamp?: number;
}

type StatsRecord = RTCStats & Record<string, unknown>;

export function inspectP2pMediaHealth(report: RTCStatsReport): P2pMediaHealth {
  let selectedPairId: string | undefined;
  let fallbackPair: StatsRecord | undefined;
  let bytesReceived = 0;
  let framesDecoded = 0;
  let packetsReceived = 0;
  let packetsLost = 0;
  let freezeCount = 0;

  report.forEach((entry) => {
    const stat = entry as StatsRecord;
    if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string') {
      selectedPairId = stat.selectedCandidatePairId;
    }
    if (stat.type === 'candidate-pair'
      && stat.state === 'succeeded'
      && (stat.nominated === true || stat.selected === true)) {
      fallbackPair = stat;
    }
    if (stat.type === 'inbound-rtp'
      && stat.isRemote !== true
      && (stat.kind === 'video' || stat.mediaType === 'video')) {
      if (typeof stat.bytesReceived === 'number') bytesReceived += stat.bytesReceived;
      if (typeof stat.framesDecoded === 'number') framesDecoded += stat.framesDecoded;
      if (typeof stat.packetsReceived === 'number') packetsReceived += stat.packetsReceived;
      if (typeof stat.packetsLost === 'number') packetsLost += stat.packetsLost;
      if (typeof stat.freezeCount === 'number') freezeCount += stat.freezeCount;
    }
  });

  const pair = (selectedPairId === undefined ? undefined : report.get(selectedPairId) as StatsRecord | undefined)
    ?? fallbackPair;
  const counters = { bytesReceived, framesDecoded, packetsReceived, packetsLost, freezeCount };
  if (!pair) return { path: 'unknown', ...counters };

  const local = typeof pair.localCandidateId === 'string'
    ? report.get(pair.localCandidateId) as StatsRecord | undefined
    : undefined;
  const remote = typeof pair.remoteCandidateId === 'string'
    ? report.get(pair.remoteCandidateId) as StatsRecord | undefined
    : undefined;
  if (local === undefined || remote === undefined) {
    return { path: 'unknown', ...counters };
  }
  const path: P2pTransportPath = local.candidateType === 'relay' || remote.candidateType === 'relay'
    ? 'relay'
    : 'direct';
  return { path, ...counters };
}

/**
 * Reads the local video sender's encoder limitation from a stats report.
 * `qualityLimitationReason` is `'none'` when unconstrained; `'bandwidth'` means
 * the encoder is constrained by the link. Resolution-first sessions may then
 * collapse frame rate, while frame-rate-first 1080p sessions are allowed to
 * reduce resolution instead.
 */
export function inspectSenderVideoStats(report: RTCStatsReport): SenderVideoStats {
  const result: SenderVideoStats = {};
  let selectedPairId: string | undefined;
  let fallbackPair: StatsRecord | undefined;
  let outbound: StatsRecord | undefined;
  report.forEach((entry) => {
    const stat = entry as StatsRecord;
    if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string') {
      selectedPairId = stat.selectedCandidatePairId;
    }
    if (stat.type === 'candidate-pair'
      && stat.state === 'succeeded'
      && (stat.nominated === true || stat.selected === true)) {
      fallbackPair = stat;
    }
    if (stat.type !== 'outbound-rtp'
      || stat.isRemote === true
      || (stat.kind !== 'video' && stat.mediaType !== 'video')) return;
    outbound = stat;
    if (typeof stat.qualityLimitationReason === 'string') {
      result.qualityLimitationReason = stat.qualityLimitationReason;
    }
    if (typeof stat.framesPerSecond === 'number') {
      result.framesPerSecond = stat.framesPerSecond;
    }
    if (typeof stat.frameWidth === 'number') {
      result.frameWidth = stat.frameWidth;
    }
    if (typeof stat.frameHeight === 'number') {
      result.frameHeight = stat.frameHeight;
    }
    if (typeof stat.bytesSent === 'number') {
      result.bytesSent = stat.bytesSent;
    }
    if (typeof stat.targetBitrate === 'number' && stat.targetBitrate > 0) {
      result.encoderTargetBitrateBps = stat.targetBitrate;
    }
    if (typeof stat.timestamp === 'number') {
      result.timestamp = stat.timestamp;
    }
  });
  const pair = (selectedPairId === undefined ? undefined : report.get(selectedPairId) as StatsRecord | undefined)
    ?? fallbackPair;
  if (pair) {
    if (typeof pair.availableOutgoingBitrate === 'number' && pair.availableOutgoingBitrate > 0) {
      result.availableOutgoingBitrateBps = pair.availableOutgoingBitrate;
    }
    // Missing fields stay undefined so absent stats cannot look like zero pressure.
    if (typeof pair.packetsDiscardedOnSend === 'number') {
      result.packetsDiscardedOnSend = pair.packetsDiscardedOnSend;
    }
    const local = typeof pair.localCandidateId === 'string'
      ? report.get(pair.localCandidateId) as StatsRecord | undefined
      : undefined;
    if (local) {
      if (typeof local.candidateType === 'string') result.selectedLocalCandidateType = local.candidateType;
      if (typeof local.url === 'string') result.selectedLocalCandidateUrl = local.url;
      if (typeof local.relayProtocol === 'string') result.selectedRelayProtocol = local.relayProtocol;
    }
  }
  const remoteInbound = findRemoteInbound(report, outbound);
  if (remoteInbound) {
    // roundTripTime is reported in seconds.
    if (typeof remoteInbound.roundTripTime === 'number' && remoteInbound.roundTripTime >= 0) {
      result.roundTripTimeMs = remoteInbound.roundTripTime * 1_000;
    }
    if (typeof remoteInbound.packetsLost === 'number') {
      result.remotePacketsLost = remoteInbound.packetsLost;
    }
    if (typeof remoteInbound.packetsReceived === 'number') {
      result.remotePacketsReceived = remoteInbound.packetsReceived;
    }
  }
  return result;
}

/** Prefers the remote report bound to this outbound stream via `remoteId`. */
function findRemoteInbound(
  report: RTCStatsReport,
  outbound: StatsRecord | undefined
): StatsRecord | undefined {
  const remoteId = typeof outbound?.remoteId === 'string' ? outbound.remoteId : undefined;
  if (remoteId !== undefined) {
    const bound = report.get(remoteId) as StatsRecord | undefined;
    if (bound && bound.type === 'remote-inbound-rtp') return bound;
  }
  let fallback: StatsRecord | undefined;
  report.forEach((entry) => {
    const stat = entry as StatsRecord;
    if (stat.type === 'remote-inbound-rtp'
      && (stat.kind === 'video' || stat.mediaType === 'video')
      && fallback === undefined) {
      fallback = stat;
    }
  });
  return fallback;
}
