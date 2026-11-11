import {
  SCREEN_SHARE_QUALITY_BATCH_SIZE,
  SCREEN_SHARE_QUALITY_MAX_LINKS,
  type ClientHostInfo,
  type ScreenShareEncoding,
  type ScreenShareQualityLink,
  type ScreenShareQualityReport,
  type ScreenShareQualitySample,
  type ScreenShareRtcQuality
} from '@meeting/contracts';
import { apiNoContent, ApiRequestError } from '../api/client.js';
import { getNativePacingStats, isNativeCaptureTrack } from './native-capture.js';
import type { ScreenCaptureConstraintResult, ScreenSharePublishOptions } from './screen-share.js';
import type { ProjectStats } from './software-media/encoder.js';
import { sameCounter, summarizeWebRtcStats, type WebRtcStatsSnapshot } from './webrtc-stats.js';

type Role = ScreenShareQualityReport['role'];
type Batch = Pick<ScreenShareQualityReport, 'sequence' | 'samples'>;
type Capture = NonNullable<ScreenShareQualitySample['capture']>;
type NativeStats = NonNullable<ReturnType<typeof getNativePacingStats>>;
type Transport = ScreenShareQualityLink['transport'];

export interface ScreenQualitySource {
  key: object;
  transport: Transport;
  report?: RTCStatsReport;
  turnProvider?: ScreenShareQualityLink['turnProvider'];
  encoding?: ScreenShareEncoding;
  project?: ProjectStats;
}

export function readScreenSenderEncoding(sender?: RTCRtpSender): ScreenShareEncoding | undefined {
  const parameters = sender?.getParameters?.();
  if (!parameters) return undefined;
  const encoding = parameters.encodings?.[0];
  return {
    maxBitrate: finite(encoding?.maxBitrate),
    maxFramerate: finite(encoding?.maxFramerate),
    scaleResolutionDownBy: finite(encoding?.scaleResolutionDownBy),
    degradationPreference: pick(parameters.degradationPreference, 'balanced', 'maintain-framerate', 'maintain-resolution')
  };
}

type SampleInput = Pick<ScreenShareQualitySample, 'at' | 'mode' | 'recovering'> & {
  links: ScreenQualitySource[];
  capture?: { track: MediaStreamTrack; options?: ScreenSharePublishOptions; android: boolean;
    constraint?: ScreenCaptureConstraintResult };
  playback?: HTMLVideoElement | null;
};

export class ScreenShareQualityRecorder {
  private readonly traceId = crypto.randomUUID().replaceAll('-', '');
  private readonly connections = new WeakMap<object, { link: number; snapshot?: WebRtcStatsSnapshot }>();
  private lastLink = 0;
  private sequence = 0;
  private samples: ScreenShareQualitySample[] = [];
  private native?: { track: MediaStreamTrack; at: number; stats: NativeStats };
  private playback?: { element: HTMLVideoElement; source: MediaProvider | null; at: number; rendered: number; dropped: number };
  private finished = false;
  private sending = false;
  private unavailable = false;
  private retry?: Batch;
  private retryAt = 0;

  static start(slug: string, owner: string, role: Role, client?: ClientHostInfo): ScreenShareQualityRecorder {
    const bytes = new TextEncoder().encode(JSON.stringify([slug, owner]));
    const sourceKey = crypto.subtle.digest('SHA-256', bytes).then(hash =>
      Array.from(new Uint8Array(hash, 0, 16), byte => byte.toString(16).padStart(2, '0')).join(''));
    return new ScreenShareQualityRecorder(slug, role, sourceKey, undefined, client);
  }

  constructor(
    slug: string,
    private readonly role: Role,
    private readonly sourceKey: Promise<string>,
    private readonly upload = (body: ScreenShareQualityReport) => apiNoContent(
      `/meetings/${encodeURIComponent(slug)}/screen-share-quality`, {
        method: 'POST',
        body: JSON.stringify(body),
        ...(body.final ? { keepalive: true } : { signal: AbortSignal.timeout(8_000) })
      }),
    private readonly client?: ClientHostInfo
  ) {}

  sample(input: SampleInput): void {
    if (this.finished || this.unavailable) return;
    const { at, mode, recovering } = input;
    const links = input.links.slice(0, SCREEN_SHARE_QUALITY_MAX_LINKS).map(source => this.readLink(source, at));
    const capture = input.capture && this.readCapture(input.capture, at);
    const playback = input.playback ? this.readPlayback(input.playback, at) : undefined;
    this.samples.push({ at, mode, recovering, hidden: document.hidden, links, capture, playback });
    if (this.samples.length > SCREEN_SHARE_QUALITY_BATCH_SIZE) this.samples.shift();
    if ((this.retry || this.samples.length === SCREEN_SHARE_QUALITY_BATCH_SIZE) && !this.sending && at >= this.retryAt) {
      void this.flush(false);
    }
  }

  finish(): Promise<void> | undefined {
    if (this.finished) return;
    this.finished = true;
    return this.flush(true);
  }

  private flush(final: boolean): Promise<void> | undefined {
    const retry = !final || !this.samples.length ? this.retry : undefined;
    if (this.unavailable || (!retry && !this.samples.length)) return;
    const batch = retry ?? { sequence: this.sequence++, samples: this.samples };
    this.retry = undefined;
    if (!retry) this.samples = [];
    if (!final) this.sending = true;
    return this.sourceKey.then(sourceKey => this.upload({
      version: 1, sourceKey, traceId: this.traceId, role: this.role, final, ...batch,
      browser: browserVersion(navigator.userAgent),
      client: this.client && /^\d{1,5}(\.\d{1,5}){1,3}$/.test(this.client.appVersion)
        ? `${this.client.platform}/${this.client.appVersion}` : undefined
    })).catch(error => {
      if (error instanceof ApiRequestError && [400, 401, 403, 404, 410, 413].includes(error.status)) {
        this.unavailable = true;
      } else if (!this.finished) {
        // Retry a failed batch once while keeping a separate, bounded recent tail.
        if (!retry) this.retry = batch;
        this.retryAt = Date.now() + 8_000;
      }
    }).finally(() => {
      if (!final) this.sending = false;
    });
  }

  private readLink(source: ScreenQualitySource, at: number): ScreenShareQualityLink {
    const entry = this.connections.get(source.key) ?? { link: ++this.lastLink };
    const previous = entry.snapshot;
    const snapshot = source.report ? summarizeWebRtcStats([source.report], previous, at) : undefined;
    entry.snapshot = snapshot;
    this.connections.set(source.key, entry);
    const { transport, turnProvider, encoding, project } = source;
    return { link: entry.link, transport, turnProvider, encoding,
      rtc: readRtcQuality(this.role, snapshot, previous),
      project: project && {
        codec: project.codec, width: project.width, height: project.height,
        captureFps: finite(project.rawFps), encodedFps: finite(project.encodedFps),
        decodedFps: finite(project.decodedFps), renderedFps: finite(project.renderedFps),
        sentBps: finite(project.sentBps), encodeMs: project.encodeMs, queueDrops: project.queueDrops,
        expiredDrops: project.expiredDrops, droppedFrames: project.droppedFrames
      }
    };
  }

  private readCapture({ track, options, android, constraint }: NonNullable<SampleInput['capture']>, at: number): Capture {
    const settings = track.getSettings?.();
    const stats = getNativePacingStats(track);
    const previous = this.native?.track === track ? this.native : undefined;
    this.native = stats ? { track, at, stats } : undefined;
    const duration = previous && at - previous.at;
    return {
      source: android ? 'android-native' : isNativeCaptureTrack(track) ? 'windows-native' : 'browser',
      displaySurface: pick(settings?.displaySurface, 'monitor', 'window', 'browser'),
      contentHint: pick(track.contentHint, 'motion', 'detail', 'text'),
      constraint,
      requestedFps: finite(options?.frameRate), requestedBitrate: finite(options?.maxBitrate),
      configuredFps: finite(settings?.frameRate), width: finite(settings?.width), height: finite(settings?.height),
      muted: track.muted === true,
      native: stats && {
        receivedFps: rate(stats.receivedFrames, previous?.stats.receivedFrames, duration),
        submittedFps: rate(stats.submittedFrames, previous?.stats.submittedFrames, duration),
        refreshFps: rate(stats.refreshFrames, previous?.stats.refreshFrames, duration),
        droppedFrames: delta(stats.droppedFrames, previous?.stats.droppedFrames),
        queuedFrames: stats.queuedFrames, inFlightFrames: stats.inFlightFrames,
        mode: stats.mode, scheduler: stats.scheduler,
        pipeline: readNativePipeline(stats.pipeline, previous?.stats.pipeline)
      }
    };
  }

  private readPlayback(element: HTMLVideoElement, at: number): ScreenShareQualitySample['playback'] {
    const quality = element.getVideoPlaybackQuality?.();
    const previous = this.playback?.element === element && this.playback.source === element.srcObject
      ? this.playback : undefined;
    const dropped = quality?.droppedVideoFrames;
    const rendered = quality && Math.max(0, quality.totalVideoFrames - quality.droppedVideoFrames);
    this.playback = quality && rendered !== undefined && dropped !== undefined
      ? { element, source: element.srcObject, at, rendered, dropped } : undefined;
    return {
      renderedFps: rate(rendered, previous?.rendered, previous && at - previous.at),
      droppedFrames: delta(dropped, previous?.dropped),
      paused: element.paused, readyState: element.readyState
    };
  }
}

function readNativePipeline(current: NativeStats['pipeline'], previous: NativeStats['pipeline']) {
  if (!current || !previous || current.at <= previous.at) return undefined;
  const intervalMs = current.at - previous.at;
  const { counters: now } = current;
  const { counters: before } = previous;
  return {
    intervalMs: Math.round(intervalMs),
    dxgiFps: rate(now.dxgiFrames, before.dxgiFrames, intervalMs),
    filteredFps: rate(now.filteredFrames, before.filteredFrames, intervalMs),
    helperFps: rate(now.capturedFrames, before.capturedFrames, intervalMs),
    contentChangedFps: rate(now.contentChangedFrames, before.contentChangedFrames, intervalMs),
    loopbackSentFps: rate(now.sentFrames, before.sentFrames, intervalMs),
    loopbackDroppedFrames: delta(now.droppedFrames, before.droppedFrames)
  };
}

function readRtcQuality(role: Role, snapshot?: WebRtcStatsSnapshot, previous?: WebRtcStatsSnapshot): ScreenShareRtcQuality | undefined {
  const sender = role === 'sender';
  const current = (sender ? snapshot?.sender : snapshot?.receiver) ?? snapshot?.connection;
  if (!current) return undefined;
  const before = sameCounter(sender ? snapshot?.counters.outboundFrames : snapshot?.counters.inboundFrames,
    sender ? previous?.counters.outboundFrames : previous?.counters.inboundFrames)
    ? (sender ? previous?.sender : previous?.receiver) : undefined;
  return {
    codec: pick(current.codec, 'H264', 'H265', 'AV1', 'VP8', 'VP9'),
    codecProfile: current.codecProfile && /^[\da-f]{6}$/i.test(current.codecProfile) ? current.codecProfile : undefined,
    powerEfficient: sender ? current.powerEfficientEncoder : current.powerEfficientDecoder,
    width: finite(current.width), height: finite(current.height),
    sourceFps: finite(current.sourceFramesPerSecond), reportedFps: finite(current.framesPerSecond),
    encodedFps: finite(current.encodedFramesPerSecond), sentFps: finite(current.sentFramesPerSecond),
    receivedFps: finite(current.receivedFramesPerSecond), decodedFps: finite(current.decodedFramesPerSecond),
    averageQp: finite(current.averageIntervalQp), encodeMs: finite(current.averageIntervalEncodeTimeMs),
    decodeMs: finite(current.averageDecodeTimeMs), assemblyMs: finite(current.averageAssemblyTimeMs),
    bitrateMbps: finite(current.bitrateMbps), encoderTargetMbps: finite(current.encoderTargetBitrateMbps),
    availableOutgoingMbps: finite(current.availableOutgoingBitrateMbps),
    limitation: pick(current.qualityLimitationReason, 'none', 'cpu', 'bandwidth', 'other'),
    packetsLost: delta(current.packetsLost, before?.packetsLost), packetsReceived: delta(current.packetsReceived, before?.packetsReceived),
    retransmittedBytes: delta(current.retransmittedBytes, before?.retransmittedBytes),
    nackCount: delta(current.nackCount, before?.nackCount), pliCount: delta(current.pliCount, before?.pliCount),
    droppedFrames: delta(current.framesDropped, before?.framesDropped),
    freezes: delta(current.freezeCount, before?.freezeCount), freezeMs: delta(current.totalFreezesMs, before?.totalFreezesMs),
    rttMs: finite(current.roundTripTimeMs), jitterMs: finite(current.jitterMs),
    jitterBufferMs: finite(current.averageIntervalJitterBufferDelayMs),
    candidateType: pick(current.selectedCandidateType, 'host', 'srflx', 'prflx', 'relay'),
    relayProtocol: pick(current.relayProtocol, 'udp', 'tcp', 'tls')
  };
}

function browserVersion(userAgent: string): string | undefined {
  const family = /(?:Edg|EdgA|EdgiOS)\/(\d{1,4})\./.exec(userAgent);
  if (family) return `edge/${family[1]}`;
  const chromium = /(?:Chrome|CriOS)\/(\d{1,4})\./.exec(userAgent);
  if (chromium) return `chrome/${chromium[1]}`;
  const firefox = /(?:Firefox|FxiOS)\/(\d{1,4})\./.exec(userAgent);
  if (firefox) return `firefox/${firefox[1]}`;
  const safari = /Version\/(\d{1,4})\..*Safari\//.exec(userAgent);
  return safari ? `safari/${safari[1]}` : undefined;
}

function pick<T extends string>(value: string | undefined, ...allowed: T[]): T | undefined {
  return allowed.find(item => item === value);
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

function delta(value: number | undefined, before: number | undefined): number | undefined {
  return value === undefined || before === undefined ? undefined : finite(value - before);
}

function rate(value: number | undefined, before: number | undefined, milliseconds: number | undefined): number | undefined {
  const count = delta(value, before);
  return count === undefined || !milliseconds || milliseconds < 0
    ? undefined : finite(Math.round(count * 10_000 / milliseconds) / 10);
}
