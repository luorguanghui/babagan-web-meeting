type StatsRecord = Record<string, unknown> & { id?: string; type?: string };

export interface WebRtcMediaStats {
  codec?: string;
  width?: number;
  height?: number;
  framesPerSecond?: number;
  bitrateMbps?: number;
  framesEncoded?: number;
  framesSent?: number;
  framesDecoded?: number;
  framesDropped?: number;
  freezeCount?: number;
  averageEncodeTimeMs?: number;
  qualityLimitationReason?: string;
  packetsLost?: number;
  roundTripTimeMs?: number;
  jitterMs?: number;
  averageJitterBufferDelayMs?: number;
  availableOutgoingBitrateMbps?: number;
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
  };
}

export function summarizeWebRtcStats(
  reports: RTCStatsReport[],
  previous?: WebRtcStatsSnapshot,
  sampledAt = Date.now()
): WebRtcStatsSnapshot {
  const entries: StatsRecord[] = [];
  for (const report of reports) report.forEach((value) => entries.push(value as unknown as StatsRecord));
  const byId = new Map(entries.filter((value) => value.id).map((value) => [value.id!, value]));
  const outbound = entries.find((value) => value.type === 'outbound-rtp' && mediaKind(value) === 'video');
  const inbound = entries.find((value) => value.type === 'inbound-rtp' && mediaKind(value) === 'video');
  const remoteInbound = entries.find((value) => value.type === 'remote-inbound-rtp' && mediaKind(value) === 'video');
  const candidatePair = entries.find((value) => value.type === 'candidate-pair'
    && value.state === 'succeeded' && (value.nominated === true || value.selected === true));
  const counters: WebRtcStatsSnapshot['counters'] = {};

  let sender: WebRtcMediaStats | undefined;
  if (outbound) {
    const bytes = numberValue(outbound.bytesSent);
    const timestamp = numberValue(outbound.timestamp) ?? sampledAt;
    if (bytes !== undefined) counters.outbound = { bytes, timestamp };
    sender = compact({
      codec: codecName(byId.get(stringValue(outbound.codecId) ?? '')),
      width: numberValue(outbound.frameWidth),
      height: numberValue(outbound.frameHeight),
      framesPerSecond: numberValue(outbound.framesPerSecond),
      bitrateMbps: bitrate(bytes, timestamp, previous?.counters.outbound),
      framesEncoded: numberValue(outbound.framesEncoded),
      framesSent: numberValue(outbound.framesSent),
      averageEncodeTimeMs: averageMilliseconds(outbound.totalEncodeTime, outbound.framesEncoded),
      qualityLimitationReason: stringValue(outbound.qualityLimitationReason),
      packetsLost: numberValue(remoteInbound?.packetsLost),
      roundTripTimeMs: secondsToMilliseconds(remoteInbound?.roundTripTime ?? candidatePair?.currentRoundTripTime),
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
    receiver = compact({
      codec: codecName(byId.get(stringValue(inbound.codecId) ?? '')),
      width: numberValue(inbound.frameWidth),
      height: numberValue(inbound.frameHeight),
      framesPerSecond: numberValue(inbound.framesPerSecond),
      bitrateMbps: bitrate(bytes, timestamp, previous?.counters.inbound),
      framesDecoded: numberValue(inbound.framesDecoded),
      framesDropped: numberValue(inbound.framesDropped),
      freezeCount: numberValue(inbound.freezeCount),
      packetsLost: numberValue(inbound.packetsLost),
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
