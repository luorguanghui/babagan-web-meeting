type StatsRecord = Record<string, unknown> & { id?: string; type?: string };

interface VideoFrameCounters {
  id?: string;
  ssrc?: number;
  timestamp: number;
  framesSent?: number;
  framesEncoded?: number;
  totalEncodeTime?: number;
  framesReceived?: number;
  framesDecoded?: number;
  totalDecodeTime?: number;
  totalAssemblyTime?: number;
  framesAssembledFromMultiplePackets?: number;
}

export interface WebRtcMediaStats {
  codec?: string;
  width?: number;
  height?: number;
  framesPerSecond?: number;
  /** Actual media-source output, distinct from configured capture constraints. */
  sourceFramesPerSecond?: number;
  averageIntervalEncodeTimeMs?: number;
  encoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  sentFramesPerSecond?: number;
  receivedFramesPerSecond?: number;
  /** Averages over the latest stats interval, not the entire session. */
  averageDecodeTimeMs?: number;
  averageAssemblyTimeMs?: number;
  decoderImplementation?: string;
  powerEfficientDecoder?: boolean;
  bitrateMbps?: number;
  framesEncoded?: number;
  framesSent?: number;
  framesDecoded?: number;
  framesDropped?: number;
  freezeCount?: number;
  averageEncodeTimeMs?: number;
  qualityLimitationReason?: string;
  packetsLost?: number;
  packetsReceived?: number;
  roundTripTimeMs?: number;
  jitterMs?: number;
  averageJitterBufferDelayMs?: number;
  availableOutgoingBitrateMbps?: number;
  /** Encoder-reported instantaneous target; distinct from the RTC estimate. */
  encoderTargetBitrateMbps?: number;
  packetsDiscardedOnSend?: number;
  selectedCandidateType?: string;
  selectedCandidateUrl?: string;
  relayProtocol?: string;
  nackCount?: number;
  pliCount?: number;
  firCount?: number;
  retransmittedBytes?: number;
}

export interface WebRtcStatsSnapshot {
  sampledAt: number;
  sender?: WebRtcMediaStats;
  receiver?: WebRtcMediaStats;
  counters: {
    outbound?: { bytes: number; timestamp: number };
    inbound?: { bytes: number; timestamp: number };
    outboundFrames?: VideoFrameCounters;
    inboundFrames?: VideoFrameCounters;
  };
}

export function summarizeWebRtcStats(
  reports: RTCStatsReport[],
  previous?: WebRtcStatsSnapshot,
  sampledAt = Date.now()
): WebRtcStatsSnapshot {
  const reportsEntries: StatsRecord[][] = reports.map((report) => {
    const values: StatsRecord[] = [];
    report.forEach((value) => values.push(value as unknown as StatsRecord));
    return values;
  });
  // Stats ids are scoped to one RTCPeerConnection and commonly repeat across
  // the sharer's per-viewer reports. Mixing reports lets a video stream from
  // one viewer accidentally resolve the candidate pair of another. Present
  // one complete representative connection so every row has one provenance.
  const entries = reportsEntries.find((values) => values.some((value) =>
    (value.type === 'outbound-rtp' || value.type === 'inbound-rtp')
      && mediaKind(value) === 'video'
  )) ?? reportsEntries[0] ?? [];
  const byId = new Map(entries.filter((value) => value.id).map((value) => [value.id!, value]));
  const outbound = entries.find((value) => value.type === 'outbound-rtp' && mediaKind(value) === 'video');
  const inbound = entries.find((value) => value.type === 'inbound-rtp' && mediaKind(value) === 'video');
  const remoteInbound = entries.find((value) => value.type === 'remote-inbound-rtp' && mediaKind(value) === 'video');
  const transport = entries.find((value) => value.type === 'transport');
  const selectedCandidatePairId = stringValue(transport?.selectedCandidatePairId);
  const candidatePair = (selectedCandidatePairId === undefined
    ? undefined
    : byId.get(selectedCandidatePairId)) ?? entries.find((value) => value.type === 'candidate-pair'
    && value.state === 'succeeded' && (value.nominated === true || value.selected === true));
  const localCandidate = typeof candidatePair?.localCandidateId === 'string'
    ? byId.get(candidatePair.localCandidateId)
    : undefined;
  const counters: WebRtcStatsSnapshot['counters'] = {};

  let sender: WebRtcMediaStats | undefined;
  if (outbound) {
    const bytes = numberValue(outbound.bytesSent);
    const timestamp = numberValue(outbound.timestamp) ?? sampledAt;
    if (bytes !== undefined) counters.outbound = { bytes, timestamp };
    const frames = frameCounters(outbound, timestamp);
    counters.outboundFrames = frames;
    const sourceId = stringValue(outbound.mediaSourceId);
    const source = sourceId ? byId.get(sourceId)
      : entries.find((value) => value.type === 'media-source' && mediaKind(value) === 'video');
    sender = compact({
      codec: codecName(byId.get(stringValue(outbound.codecId) ?? '')),
      width: numberValue(outbound.frameWidth),
      height: numberValue(outbound.frameHeight),
      framesPerSecond: numberValue(outbound.framesPerSecond),
      sourceFramesPerSecond: numberValue(source?.framesPerSecond),
      averageIntervalEncodeTimeMs: intervalMilliseconds(frames, previous?.counters.outboundFrames,
        'totalEncodeTime', 'framesEncoded'),
      encoderImplementation: stringValue(outbound.encoderImplementation),
      powerEfficientEncoder: typeof outbound.powerEfficientEncoder === 'boolean'
        ? outbound.powerEfficientEncoder : undefined,
      sentFramesPerSecond: frameRate(frames, previous?.counters.outboundFrames, 'framesSent'),
      bitrateMbps: bitrate(bytes, timestamp, previous?.counters.outbound),
      framesEncoded: numberValue(outbound.framesEncoded),
      framesSent: numberValue(outbound.framesSent),
      averageEncodeTimeMs: averageMilliseconds(outbound.totalEncodeTime, outbound.framesEncoded),
      qualityLimitationReason: stringValue(outbound.qualityLimitationReason),
      packetsLost: numberValue(remoteInbound?.packetsLost),
      packetsReceived: numberValue(remoteInbound?.packetsReceived),
      roundTripTimeMs: secondsToMilliseconds(remoteInbound?.roundTripTime ?? candidatePair?.currentRoundTripTime),
      // The encoder's own instantaneous target, kept separate from the RTC estimate.
      encoderTargetBitrateMbps: toMbps(outbound.targetBitrate),
      packetsDiscardedOnSend: numberValue(candidatePair?.packetsDiscardedOnSend),
      selectedCandidateType: stringValue(localCandidate?.candidateType),
      selectedCandidateUrl: stringValue(localCandidate?.url),
      relayProtocol: stringValue(localCandidate?.relayProtocol),
      availableOutgoingBitrateMbps: toMbps(candidatePair?.availableOutgoingBitrate),
      nackCount: numberValue(outbound.nackCount),
      pliCount: numberValue(outbound.pliCount),
      firCount: numberValue(outbound.firCount),
      retransmittedBytes: numberValue(outbound.retransmittedBytesSent)
    });
  }

  let receiver: WebRtcMediaStats | undefined;
  if (inbound) {
    const bytes = numberValue(inbound.bytesReceived);
    const timestamp = numberValue(inbound.timestamp) ?? sampledAt;
    if (bytes !== undefined) counters.inbound = { bytes, timestamp };
    const frames = frameCounters(inbound, timestamp);
    counters.inboundFrames = frames;
    receiver = compact({
      codec: codecName(byId.get(stringValue(inbound.codecId) ?? '')),
      width: numberValue(inbound.frameWidth),
      height: numberValue(inbound.frameHeight),
      framesPerSecond: numberValue(inbound.framesPerSecond),
      receivedFramesPerSecond: frameRate(frames, previous?.counters.inboundFrames, 'framesReceived'),
      averageDecodeTimeMs: intervalMilliseconds(frames, previous?.counters.inboundFrames,
        'totalDecodeTime', 'framesDecoded'),
      averageAssemblyTimeMs: intervalMilliseconds(frames, previous?.counters.inboundFrames,
        'totalAssemblyTime', 'framesAssembledFromMultiplePackets'),
      decoderImplementation: stringValue(inbound.decoderImplementation),
      powerEfficientDecoder: typeof inbound.powerEfficientDecoder === 'boolean'
        ? inbound.powerEfficientDecoder : undefined,
      bitrateMbps: bitrate(bytes, timestamp, previous?.counters.inbound),
      framesDecoded: numberValue(inbound.framesDecoded),
      framesDropped: numberValue(inbound.framesDropped),
      freezeCount: numberValue(inbound.freezeCount),
      packetsLost: numberValue(inbound.packetsLost),
      packetsReceived: numberValue(inbound.packetsReceived),
      roundTripTimeMs: secondsToMilliseconds(candidatePair?.currentRoundTripTime),
      jitterMs: secondsToMilliseconds(inbound.jitter),
      averageJitterBufferDelayMs: averageMilliseconds(inbound.jitterBufferDelay, inbound.jitterBufferEmittedCount),
      nackCount: numberValue(inbound.nackCount),
      pliCount: numberValue(inbound.pliCount),
      firCount: numberValue(inbound.firCount),
      retransmittedBytes: numberValue(inbound.retransmittedBytesReceived)
    });
  }

  return { sampledAt, ...(sender ? { sender } : {}), ...(receiver ? { receiver } : {}), counters };
}

function mediaKind(value: StatsRecord): unknown {
  return value.kind ?? value.mediaType;
}

function frameCounters(value: StatsRecord, timestamp: number): VideoFrameCounters {
  return {
    id: stringValue(value.id), ssrc: numberValue(value.ssrc), timestamp,
    framesSent: numberValue(value.framesSent),
    framesEncoded: numberValue(value.framesEncoded),
    totalEncodeTime: numberValue(value.totalEncodeTime),
    framesReceived: numberValue(value.framesReceived),
    framesDecoded: numberValue(value.framesDecoded),
    totalDecodeTime: numberValue(value.totalDecodeTime),
    totalAssemblyTime: numberValue(value.totalAssemblyTime),
    framesAssembledFromMultiplePackets: numberValue(value.framesAssembledFromMultiplePackets)
  };
}

type FrameCounterKey = Exclude<keyof VideoFrameCounters, 'id' | 'ssrc' | 'timestamp'>;

function frameDelta(current: VideoFrameCounters, previous: VideoFrameCounters | undefined,
  key: FrameCounterKey): number | undefined {
  // A replacement stream must establish its own baseline, even if a new PC
  // reuses the same stats id and its counters happen to be larger.
  if (!previous || current.timestamp <= previous.timestamp
    || current.id !== previous.id || current.ssrc !== previous.ssrc) return undefined;
  const value = current[key];
  const before = previous[key];
  return value === undefined || before === undefined || value < before ? undefined : value - before;
}

function frameRate(current: VideoFrameCounters, previous: VideoFrameCounters | undefined,
  key: 'framesSent' | 'framesReceived'): number | undefined {
  const count = frameDelta(current, previous, key);
  return count === undefined || !previous ? undefined
    : round(count * 1_000 / (current.timestamp - previous.timestamp), 1);
}

function intervalMilliseconds(current: VideoFrameCounters, previous: VideoFrameCounters | undefined,
  total: 'totalEncodeTime' | 'totalDecodeTime' | 'totalAssemblyTime',
  count: 'framesEncoded' | 'framesDecoded' | 'framesAssembledFromMultiplePackets'): number | undefined {
  return averageMilliseconds(frameDelta(current, previous, total), frameDelta(current, previous, count));
}

function codecName(value?: StatsRecord): string | undefined {
  const mimeType = stringValue(value?.mimeType);
  return mimeType?.split('/').at(-1)?.toUpperCase();
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function secondsToMilliseconds(value: unknown): number | undefined {
  const number = numberValue(value);
  return number === undefined ? undefined : round(number * 1_000, 1);
}

function averageMilliseconds(total: unknown, count: unknown): number | undefined {
  const totalNumber = numberValue(total);
  const countNumber = numberValue(count);
  return totalNumber === undefined || !countNumber ? undefined : round(totalNumber * 1_000 / countNumber, 2);
}

function toMbps(value: unknown): number | undefined {
  const bitsPerSecond = numberValue(value);
  return bitsPerSecond === undefined ? undefined : round(bitsPerSecond / 1_000_000, 2);
}

function bitrate(
  bytes: number | undefined,
  timestamp: number,
  previous?: { bytes: number; timestamp: number }
): number | undefined {
  if (bytes === undefined || !previous || timestamp <= previous.timestamp || bytes < previous.bytes) return undefined;
  return round((bytes - previous.bytes) * 8 / ((timestamp - previous.timestamp) * 1_000), 2);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
