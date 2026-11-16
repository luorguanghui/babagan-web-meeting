import {
  SCREEN_SHARE_ICE_AGE_MAX_MS,
  SCREEN_SHARE_ICE_COUNTER_MAX,
  type ScreenShareIceQuality
} from '@meeting/contracts';

export type ScreenIceRetryReason = NonNullable<ScreenShareIceQuality['lastRetryReason']>;
export type ScreenIceAttemptReason = ScreenShareIceQuality['attemptReason'];
export type ScreenIcePolicyReason = ScreenShareIceQuality['policyReason'];
export type ScreenIceSource = Pick<ScreenShareIceQuality,
  'requestedPolicy' | 'appliedPolicy' | 'policyReason' | 'state' | 'gatheringState' | 'ageMs' | 'attemptReason'
  | 'lastRetryReason' | 'lastRetryAgoMs' | 'localCandidateErrors' | 'remoteCandidateErrors'>;

type Stat = RTCStats & Record<string, unknown>;

export function iceElapsedMs(now: number, then: number): number {
  return Math.min(SCREEN_SHARE_ICE_AGE_MAX_MS, Math.max(0, Math.round(now - then)));
}

export function incrementIceCounter(count: number): number {
  return Math.min(SCREEN_SHARE_ICE_COUNTER_MAX, count + 1);
}

function candidateType(stat?: Stat): RTCIceCandidateType | undefined {
  switch (stat?.candidateType) {
    case 'host':
    case 'srflx':
    case 'prflx':
    case 'relay':
      return stat.candidateType;
  }
}

function addCounter(total: number | undefined, value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(SCREEN_SHARE_ICE_COUNTER_MAX, (total ?? 0) + value)
    : total;
}

export function readScreenIceQuality(
  source: ScreenIceSource,
  report: RTCStatsReport | undefined,
  transport: string
): ScreenShareIceQuality {
  const get = (id: unknown): Stat | undefined => typeof id === 'string' ? report?.get(id) as Stat | undefined : undefined;
  let localDirectCandidates: number | undefined;
  let remoteDirectCandidates: number | undefined;
  let directChecksSent: number | undefined;
  let directResponsesReceived: number | undefined;
  let transportPairId: unknown;
  let videoTransportId: unknown;
  let fallbackPair: Stat | undefined;
  report?.forEach(entry => {
    const stat = entry as Stat;
    if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string') {
      transportPairId ??= stat.selectedCandidatePairId;
    }
    if ((stat.type === 'inbound-rtp' || stat.type === 'outbound-rtp')
      && (stat.kind === 'video' || stat.mediaType === 'video')) {
      videoTransportId ??= stat.transportId;
    }
    if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
      const type = candidateType(stat);
      if (type === undefined) return;
      const direct = type === 'relay' ? 0 : 1;
      if (stat.type === 'local-candidate') localDirectCandidates = addCounter(localDirectCandidates, direct);
      else remoteDirectCandidates = addCounter(remoteDirectCandidates, direct);
    }
    if (stat.type !== 'candidate-pair') return;
    if (stat.state === 'succeeded' && (stat.nominated === true || stat.selected === true)) fallbackPair ??= stat;
    const local = candidateType(get(stat.localCandidateId));
    const remote = candidateType(get(stat.remoteCandidateId));
    if (!local || !remote || local === 'relay' || remote === 'relay') return;
    directChecksSent = addCounter(directChecksSent, stat.requestsSent);
    directResponsesReceived = addCounter(directResponsesReceived, stat.responsesReceived);
  });

  const pair = get(get(videoTransportId)?.selectedCandidatePairId) ?? get(transportPairId) ?? fallbackPair;
  const localCandidateType = candidateType(get(pair?.localCandidateId));
  const remoteCandidateType = candidateType(get(pair?.remoteCandidateId));
  const selectedReason = localCandidateType === 'relay' || remoteCandidateType === 'relay' ? 'relay-pair'
    : localCandidateType && remoteCandidateType ? 'direct-pair'
    : transport === 'turn' && source.appliedPolicy === 'relay' ? 'relay-policy' : 'unknown';
  return {
    requestedPolicy: source.requestedPolicy,
    appliedPolicy: source.appliedPolicy,
    policyReason: source.policyReason,
    state: source.state,
    gatheringState: source.gatheringState,
    ageMs: source.ageMs,
    attemptReason: source.attemptReason,
    lastRetryReason: source.lastRetryReason,
    lastRetryAgoMs: source.lastRetryAgoMs,
    localCandidateErrors: source.localCandidateErrors,
    remoteCandidateErrors: source.remoteCandidateErrors,
    selectedReason,
    localCandidateType,
    remoteCandidateType,
    localDirectCandidates,
    remoteDirectCandidates,
    directChecksSent,
    directResponsesReceived
  };
}
