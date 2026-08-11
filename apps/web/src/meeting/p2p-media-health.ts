export interface P2pMediaHealth {
  direct: boolean;
  bytesReceived: number;
  framesDecoded: number;
}

type StatsRecord = RTCStats & Record<string, unknown>;

export function inspectP2pMediaHealth(report: RTCStatsReport): P2pMediaHealth {
  let selectedPairId: string | undefined;
  let fallbackPair: StatsRecord | undefined;
  let bytesReceived = 0;
  let framesDecoded = 0;

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
    }
  });

  const pair = (selectedPairId === undefined ? undefined : report.get(selectedPairId) as StatsRecord | undefined)
    ?? fallbackPair;
  if (!pair) return { direct: false, bytesReceived, framesDecoded };

  const local = typeof pair.localCandidateId === 'string'
    ? report.get(pair.localCandidateId) as StatsRecord | undefined
    : undefined;
  const remote = typeof pair.remoteCandidateId === 'string'
    ? report.get(pair.remoteCandidateId) as StatsRecord | undefined
    : undefined;
  const direct = local !== undefined
    && remote !== undefined
    && local.candidateType !== 'relay'
    && remote.candidateType !== 'relay';
  return { direct, bytesReceived, framesDecoded };
}
