export type P2pTransportPath = 'direct' | 'relay' | 'unknown';

export interface P2pMediaHealth {
  path: P2pTransportPath;
  bytesReceived: number;
  framesDecoded: number;
  packetsReceived: number;
  packetsLost: number;
  freezeCount: number;
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
