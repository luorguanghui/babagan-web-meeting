export interface MoqMediaReading {
  protocol: 'moqt-18';
  codec?: string;
  width?: number;
  height?: number;
  frameCount?: number;
  videoBytes?: number;
  audioBytes?: number;
  hasAudio?: boolean;
  relayRttMs?: number;
  transportBytesSent?: number;
  transportBytesReceived?: number;
}

export interface MoqStatsSnapshot {
  role: 'sender' | 'viewer';
  protocol: MoqMediaReading['protocol'];
  codec?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  renderedFps?: number;
  droppedFrames?: number;
  videoMbps?: number;
  audioMbps?: number;
  relayMbps?: number;
  relayRttMs?: number;
  hasAudio?: boolean;
}

export interface MoqStatsSample {
  session: object;
  at: number;
  media: MoqMediaReading;
  playback?: { stream: MediaStream; frames: number; dropped: number };
}

export function summarizeMoqStats(
  role: MoqStatsSnapshot['role'],
  current: MoqStatsSample,
  previous?: MoqStatsSample
): MoqStatsSnapshot {
  const prior = previous?.session === current.session ? previous : undefined;
  const seconds = prior ? (current.at - prior.at) / 1_000 : 0;
  const media = current.media;
  const priorMedia = prior?.media;
  const playback = current.playback;
  const priorPlayback = prior?.playback?.stream === playback?.stream ? prior?.playback : undefined;
  const rate = (after?: number, before?: number, multiplier = 1) =>
    seconds > 0 && after !== undefined && before !== undefined && Number.isFinite(after) && Number.isFinite(before) && after >= before
      ? (after - before) / seconds * multiplier
      : undefined;
  const relayDirection = role === 'sender' ? 'transportBytesSent' : 'transportBytesReceived';
  return {
    role,
    protocol: media.protocol,
    codec: media.codec,
    width: media.width,
    height: media.height,
    frameRate: rate(media.frameCount, priorMedia?.frameCount),
    renderedFps: rate(playback?.frames, priorPlayback?.frames),
    droppedFrames: playback?.dropped,
    videoMbps: rate(media.videoBytes, priorMedia?.videoBytes, 8 / 1_000_000),
    audioMbps: rate(media.audioBytes, priorMedia?.audioBytes, 8 / 1_000_000),
    relayMbps: rate(media[relayDirection], priorMedia?.[relayDirection], 8 / 1_000_000),
    relayRttMs: media.relayRttMs,
    hasAudio: media.hasAudio
  };
}
