import { Type, type Static } from '@sinclair/typebox';

const textEnum = <T extends string>(...values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
const number = () => Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const optionalNumber = () => Type.Optional(number());
const key = Type.String({ pattern: '^[a-f0-9]{32}$' });

const RtcQualitySchema = Type.Object({
  codec: Type.Optional(textEnum('H264', 'H265', 'AV1', 'VP8', 'VP9')),
  codecProfile: Type.Optional(Type.String({ pattern: '^[a-fA-F0-9]{6}$' })),
  powerEfficient: Type.Optional(Type.Boolean()),
  width: optionalNumber(),
  height: optionalNumber(),
  sourceFps: optionalNumber(),
  reportedFps: optionalNumber(),
  encodedFps: optionalNumber(),
  sentFps: optionalNumber(),
  receivedFps: optionalNumber(),
  decodedFps: optionalNumber(),
  averageQp: optionalNumber(),
  encodeMs: optionalNumber(),
  decodeMs: optionalNumber(),
  assemblyMs: optionalNumber(),
  bitrateMbps: optionalNumber(),
  encoderTargetMbps: optionalNumber(),
  availableOutgoingMbps: optionalNumber(),
  limitation: Type.Optional(textEnum('none', 'cpu', 'bandwidth', 'other')),
  packetsLost: optionalNumber(),
  packetsReceived: optionalNumber(),
  retransmittedBytes: optionalNumber(),
  nackCount: optionalNumber(),
  pliCount: optionalNumber(),
  droppedFrames: optionalNumber(),
  freezes: optionalNumber(),
  freezeMs: optionalNumber(),
  rttMs: optionalNumber(),
  jitterMs: optionalNumber(),
  jitterBufferMs: optionalNumber(),
  candidateType: Type.Optional(textEnum('host', 'srflx', 'prflx', 'relay')),
  relayProtocol: Type.Optional(textEnum('udp', 'tcp', 'tls'))
}, { additionalProperties: false });

const EncodingSchema = Type.Object({
  maxBitrate: optionalNumber(),
  maxFramerate: optionalNumber(),
  scaleResolutionDownBy: optionalNumber(),
  degradationPreference: Type.Optional(textEnum('balanced', 'maintain-framerate', 'maintain-resolution'))
}, { additionalProperties: false });

const ProjectQualitySchema = Type.Object({
  codec: textEnum('h264', 'vp8'),
  width: number(), height: number(), captureFps: optionalNumber(), encodedFps: optionalNumber(),
  decodedFps: optionalNumber(), renderedFps: optionalNumber(), encodeMs: number(),
  sentBps: optionalNumber(), queueDrops: number(), expiredDrops: number(), droppedFrames: number()
}, { additionalProperties: false });

const LinkSchema = Type.Object({
  link: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  transport: textEnum('p2p', 'turn', 'sfu', 'cloudflare-sfu', 'negotiating'),
  turnProvider: Type.Optional(textEnum('coturn', 'cloudflare')),
  rtc: Type.Optional(RtcQualitySchema),
  encoding: Type.Optional(EncodingSchema),
  project: Type.Optional(ProjectQualitySchema)
}, { additionalProperties: false });

const CaptureSchema = Type.Object({
  source: textEnum('browser', 'windows-native', 'android-native'),
  displaySurface: Type.Optional(textEnum('monitor', 'window', 'browser')),
  contentHint: Type.Optional(textEnum('motion', 'detail', 'text')),
  constraint: Type.Optional(textEnum('applied', 'fallback', 'failed')),
  requestedFps: optionalNumber(),
  configuredFps: optionalNumber(),
  requestedBitrate: optionalNumber(),
  width: optionalNumber(),
  height: optionalNumber(),
  muted: Type.Boolean(),
  native: Type.Optional(Type.Object({
    receivedFps: optionalNumber(), submittedFps: optionalNumber(), refreshFps: optionalNumber(),
    droppedFrames: optionalNumber(), queuedFrames: number(), inFlightFrames: number(),
    mode: textEnum('local', 'worker'), scheduler: textEnum('atomics', 'timer')
  }, { additionalProperties: false }))
}, { additionalProperties: false });

export const SCREEN_SHARE_QUALITY_MAX_LINKS = 5;
const SampleSchema = Type.Object({
  at: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  mode: textEnum('p2p', 'turn', 'sfu', 'cloudflare-sfu', 'negotiating', 'mixed', 'waiting'),
  hidden: Type.Optional(Type.Boolean()),
  recovering: Type.Optional(Type.Boolean()),
  capture: Type.Optional(CaptureSchema),
  playback: Type.Optional(Type.Object({
    renderedFps: optionalNumber(), droppedFrames: optionalNumber(),
    paused: Type.Boolean(), readyState: Type.Integer({ minimum: 0, maximum: 4 })
  }, { additionalProperties: false })),
  links: Type.Array(LinkSchema, { maxItems: SCREEN_SHARE_QUALITY_MAX_LINKS })
}, { additionalProperties: false });

export const SCREEN_SHARE_QUALITY_BATCH_SIZE = 8;
export const SCREEN_SHARE_QUALITY_BODY_LIMIT = 48 * 1024;
export const ScreenShareQualityReportSchema = Type.Object({
  version: Type.Literal(1),
  sourceKey: key,
  traceId: key,
  role: textEnum('sender', 'viewer'),
  sequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  final: Type.Boolean(),
  browser: Type.Optional(Type.String({ pattern: '^(edge|chrome|firefox|safari)/[0-9]{1,4}$' })),
  client: Type.Optional(Type.String({ pattern: '^(windows|android)/[0-9]{1,5}(\\.[0-9]{1,5}){1,3}$' })),
  samples: Type.Array(SampleSchema, { minItems: 1, maxItems: SCREEN_SHARE_QUALITY_BATCH_SIZE })
}, { additionalProperties: false });

export type ScreenShareQualityReport = Static<typeof ScreenShareQualityReportSchema>;
export type ScreenShareQualitySample = Static<typeof SampleSchema>;
export type ScreenShareQualityLink = Static<typeof LinkSchema>;
export type ScreenShareEncoding = Static<typeof EncodingSchema>;
export type ScreenShareRtcQuality = Static<typeof RtcQualitySchema>;
