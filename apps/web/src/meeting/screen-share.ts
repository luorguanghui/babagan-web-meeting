import {
  P2P_SCREEN_BITRATES,
  type P2pScreenBitrate,
  type ScreenShareCodec,
  type ScreenShareQuality
} from '@meeting/contracts';

import type { P2pShareController, ViewerSessionState } from './p2p-share-controller.js';
import type { Peer } from './p2p-signaling.js';
import { isNativeCaptureTrack } from './native-capture.js';
import { abortableCapture, captureAborted, stopCaptureStream } from './capture-abort.js';
import { isAndroidPlaybackAudioTrack } from '../client/android-capture.js';

export interface ScreenShareQualityPreset {
  width: number;
  height: number;
  frameRate: number;
  degradationPreference: RTCDegradationPreference;
  contentHint: 'motion' | 'detail';
}

/**
 * Screen-share quality presets applied to both the SFU fallback and the P2P
 * path. All presets capture at least 1080p when the source supports it.
 * Dynamic content keeps the motion encoder hint independently of its
 * resolution protection. Capture cadence is separate from publication rate.
 */
export const screenShareQualityPresets: Record<ScreenShareQuality, ScreenShareQualityPreset> = {
  flow: { width: 1920, height: 1080, frameRate: 30, degradationPreference: 'maintain-resolution', contentHint: 'detail' },
  standard: { width: 1920, height: 1080, frameRate: 30, degradationPreference: 'maintain-framerate', contentHint: 'motion' },
  motion: { width: 1920, height: 1080, frameRate: 60, degradationPreference: 'maintain-resolution', contentHint: 'motion' },
  detail60: { width: 1920, height: 1080, frameRate: 60, degradationPreference: 'maintain-resolution', contentHint: 'detail' }
};

export const screenShareDefaultQuality: ScreenShareQuality = 'standard';
export const screenShareContentHint = 'detail' as const;
export const screenShareAudioContentHint = 'music' as const;

/**
 * P2P screen-share bitrate tiers (contracts constants): the direct peer-to-peer
 * path is the preferred share path, so the user-facing selector offers these.
 */
export const screenShareBitrates = P2P_SCREEN_BITRATES;
export type ScreenShareBitrate = P2pScreenBitrate;
/** Default P2P bitrate. */
export const screenShareDefaultBitrate = 10_000_000;
/**
 * Suggested per-viewer caps: 60fps profiles use 20 Mbps for one/two viewers,
 * 10 Mbps for more; 30fps profiles retain 8/5 Mbps. Manual caps are preserved
 * by the caller, and the sender retains its aggregate uplink budget.
 */
export function recommendP2pBitrate(viewerCount: number, quality: ScreenShareQuality = screenShareDefaultQuality): ScreenShareBitrate {
  if (screenShareQualityPresets[quality].frameRate === 60) return viewerCount >= 3 ? 10_000_000 : 20_000_000;
  return viewerCount >= 4 ? 5_000_000 : 8_000_000;
}

/** SFU (LiveKit) fallback bitrate tiers, kept from the pre-P2P implementation. */
export const sfuScreenShareBitrates = [10_000_000, 13_000_000, 15_000_000] as const;
/** Bitrate ceiling used when the share runs over the SFU fallback path. */
export const sfuScreenShareFallbackBitrate = 10_000_000;

export type ScreenShareStatus = 'idle' | 'starting' | 'sharing' | 'stopping';
export type UnrestrictedSystemAudioChoice = 'share-audio' | 'video-only' | 'cancel';

export interface ScreenShareState {
  status: ScreenShareStatus;
  stream?: MediaStream;
  audioGuidance?: string;
}

export interface ScreenSharePublisher {
  publish(stream: MediaStream, options: ScreenSharePublishOptions): Promise<void>;
  release(stream: MediaStream): Promise<void>;
}

export interface ScreenShareController {
  start(
    codec?: ScreenShareCodec,
    maxBitrate?: ScreenShareBitrate,
    quality?: ScreenShareQuality,
    encodingEngine?: 'project' | 'browser'
  ): Promise<void>;
  stop(): Promise<void>;
  getState(): ScreenShareState;
  subscribe(listener: (state: ScreenShareState) => void): () => void;
}

const audioGuidance = 'No computer audio was shared. In Chrome or Edge, choose a browser tab and enable “Share tab audio”, or choose Entire screen and enable system audio in the share picker.';
const videoOnlyGuidance = 'The screen is being shared without computer audio because the browser could not prevent meeting echo.';
const unrestrictedAudioGuidance = 'The browser could not isolate meeting playback from system audio. You chose to continue with the echo risk.';
const tabAudioGuidance = 'Screen sharing was cancelled. Choose a browser tab and enable “Share tab audio” for isolated content audio.';

class BrowserScreenShareController implements ScreenShareController {
  private state: ScreenShareState = { status: 'idle' };
  private readonly listeners = new Set<(state: ScreenShareState) => void>();
  private activeStream?: MediaStream;
  private publication?: Promise<void>;
  private stopPromise?: Promise<void>;
  private stoppingStartup = false;
  private startAbort?: AbortController;
  private startWork?: Promise<void>;
  private startRequest = 0;
  private stopTracks?: () => void;
  private releaseResources?: () => Promise<void>;
  /** Monotonic generation of `start()`; a start that is no longer current must abort. */
  private startGen = 0;
  /** Removes the current start's `ended` listener; the newer start owns this slot. */
  private endedCleanup?: () => void;

  constructor(private readonly dependencies: {
    requestGrant(): Promise<void>;
    releaseGrant(): Promise<void>;
    getDisplayMedia(constraints: DisplayMediaStreamOptions, signal?: AbortSignal): Promise<MediaStream>;
    supportsOwnAudioRestriction(): boolean;
    chooseUnrestrictedSystemAudio(context: { displaySurface: string }): Promise<UnrestrictedSystemAudioChoice>;
    cancelPendingCapture?(): void;
    publisher: ScreenSharePublisher;
  }) {}

  async start(
    codec: ScreenShareCodec = 'h264',
    maxBitrate: ScreenShareBitrate = screenShareDefaultBitrate,
    quality: ScreenShareQuality = screenShareDefaultQuality,
    encodingEngine?: 'project' | 'browser'
  ): Promise<void> {
    const request = ++this.startRequest;
    if (this.stopPromise) await this.stopPromise;
    if (this.startRequest !== request) return;
    if (this.state.status !== 'idle') throw new Error('Screen sharing is already active.');
    const myGen = ++this.startGen;
    const abort = new AbortController();
    this.startAbort = abort;
    let begin!: () => void;
    const work = new Promise<void>((resolve, reject) => {
      begin = () => { void this.startCapture(codec, maxBitrate, quality, encodingEngine, myGen, abort.signal).then(resolve, reject); };
    });
    this.startWork = work;
    this.update({ status: 'starting', stream: undefined, audioGuidance: undefined });
    begin();
    try { await work; } finally { if (this.startWork === work) this.startWork = undefined; }
  }

  private async startCapture(codec: ScreenShareCodec, maxBitrate: ScreenShareBitrate,
    quality: ScreenShareQuality, encodingEngine: 'project' | 'browser' | undefined, myGen: number, signal: AbortSignal): Promise<void> {
    const settings = screenShareQualityPresets[quality];
    let grantAcquired = false;
    let publicationStarted = false;
    let stream: MediaStream | undefined;
    let tracksStopped = false;
    const stopTracks = () => {
      if (tracksStopped || !stream) return;
      tracksStopped = true; stopCaptureStream(stream);
    };
    const assertCurrent = () => {
      if (signal.aborted || this.startGen !== myGen) throw captureAborted();
    };
    let released: Promise<void> | undefined;
    const releaseResources = () => released ??= Promise.allSettled([
      ...(stream && publicationStarted ? [Promise.resolve().then(() => this.dependencies.publisher.release(stream!))] : []),
      ...(grantAcquired ? [Promise.resolve().then(() => this.dependencies.releaseGrant())] : [])
    ]).then(() => undefined);
    this.releaseResources = releaseResources;
    let shareAudioGuidance: string | undefined;
    try {
      assertCurrent();
      await this.dependencies.requestGrant();
      grantAcquired = true;
      assertCurrent();
      stream = await abortableCapture(() => this.dependencies.getDisplayMedia({
        video: {
          // Inspect native dimensions before applying the aspect-aware cap.
          // A 16:9 picker hint can already shrink an ultrawide source below 1080p.
          frameRate: { ideal: settings.frameRate }
        },
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
          restrictOwnAudio: true
        } as MediaTrackConstraints & {
          restrictOwnAudio: boolean;
        },
        systemAudio: 'include',
        windowAudio: 'window',
        selfBrowserSurface: 'exclude'
      } as DisplayMediaStreamOptions & {
        systemAudio: 'include';
        windowAudio: 'window';
        selfBrowserSurface: 'exclude';
      }, signal), signal, stopCaptureStream);
      assertCurrent();
      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack) throw new Error('The selected source did not provide a video track.');
      const assertCaptureLive = () => {
        assertCurrent();
        if (videoTrack.readyState === 'ended') throw captureAborted();
      };
      assertCaptureLive();
      this.activeStream = stream;
      this.stopTracks = stopTracks;
      const onEnded = () => { if (this.startGen === myGen) void this.stop(); };
      videoTrack.addEventListener('ended', onEnded, { once: true });
      this.endedCleanup = () => videoTrack.removeEventListener('ended', onEnded);
      const displaySurface = videoTrack.getSettings?.().displaySurface;
      const [audioTrack] = stream.getAudioTracks();
      if (audioTrack) {
        audioTrack.contentHint = screenShareAudioContentHint;
        await abortableCapture(() => typeof audioTrack.applyConstraints === 'function'
          ? audioTrack.applyConstraints({
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false
          }).catch(() => undefined)
          : undefined, signal);
        const ownAudioRestricted = await abortableCapture(() => this.verifyOwnAudioRestriction(audioTrack), signal);
        if ((displaySurface === 'monitor' || displaySurface === 'window') && !ownAudioRestricted) {
          const choice = await abortableCapture(() => this.dependencies.chooseUnrestrictedSystemAudio({ displaySurface }), signal);
          assertCurrent();
          if (choice === 'cancel') {
            stopTracks();
            await releaseResources();
            grantAcquired = false;
            this.endedCleanup?.(); this.endedCleanup = undefined;
            this.activeStream = undefined; this.stopTracks = undefined;
            this.releaseResources = undefined;
            stream = undefined;
            this.update({ status: 'idle', stream: undefined, audioGuidance: tabAudioGuidance });
            return;
          }
          if (choice === 'video-only') {
            for (const track of stream.getAudioTracks()) {
              stream.removeTrack(track);
              track.stop();
            }
            shareAudioGuidance = videoOnlyGuidance;
          } else {
            shareAudioGuidance = unrestrictedAudioGuidance;
          }
        }
      }
      assertCurrent();
      // Keep the source aspect ratio and a 1080px short side. A 1920px
      // width cap alone would shrink ultrawide captures below 1080p.
      const sourceSettings = videoTrack.getSettings?.() ?? {};
      const portrait = (sourceSettings.height ?? 0) > (sourceSettings.width ?? 0);
      const sourceWidth = sourceSettings.width;
      const sourceHeight = sourceSettings.height;
      const sourceScale = sourceWidth && sourceHeight
        ? Math.max(1, Math.min(sourceWidth, sourceHeight) / 1080) : undefined;
      const maximumWidth = sourceScale && sourceWidth
        ? Math.round(sourceWidth / sourceScale) : portrait ? settings.height : settings.width;
      const maximumHeight = sourceScale && sourceHeight
        ? Math.round(sourceHeight / sourceScale) : portrait ? settings.width : settings.height;
      if (typeof videoTrack.applyConstraints === 'function' && !isNativeCaptureTrack(videoTrack)) {
        const compatibleConstraints = {
          width: { max: maximumWidth }, height: { max: maximumHeight },
          frameRate: { ideal: settings.frameRate }
        };
        const sixtyFps = settings.frameRate === 60;
        await abortableCapture(() => videoTrack.applyConstraints(sixtyFps
          ? { ...compatibleConstraints, frameRate: { min: 60, ideal: 60, max: 60 } }
          : compatibleConstraints).catch(async () => {
          if (sixtyFps && !signal.aborted) await videoTrack.applyConstraints(compatibleConstraints).catch(() => undefined);
        }), signal);
      }
      assertCaptureLive();
      // Set before publication so the encoder starts in the intended content
      // mode. Detail favors sharp individual frames and can drop motion frames
      // even while outbound qualityLimitationReason remains "none".
      videoTrack.contentHint = settings.contentHint;
      const publication = Promise.resolve().then(() => {
        assertCaptureLive();
        publicationStarted = true;
        return this.dependencies.publisher.publish(stream!, {
          maxBitrate,
          frameRate: settings.frameRate,
          degradationPreference: settings.degradationPreference,
          codec,
          ...(isNativeCaptureTrack(videoTrack) ? { nativeCapture: true } : {}),
          ...(encodingEngine ? { encodingEngine } : {})
        });
      });
      this.publication = publication;
      await publication;
      if (this.publication === publication) this.publication = undefined;
      if (this.activeStream !== stream) {
        await this.stopPromise;
        return;
      }
      this.update({
        status: 'sharing',
        stream,
        audioGuidance: shareAudioGuidance
          ?? (stream.getAudioTracks().length === 0 ? audioGuidance : undefined)
      });
    } catch (error) {
      const superseded = this.startGen !== myGen;
      if (!superseded && stream && this.activeStream !== stream && this.stopPromise && this.publication) {
        await this.stopPromise;
        return;
      }
      stopTracks();
      await releaseResources();
      if (superseded) {
        // A superseded start fails silently: a newer start owns the state machine.
        return;
      }
      this.endedCleanup?.();
      this.endedCleanup = undefined;
      this.activeStream = undefined;
      this.stopTracks = undefined;
      this.releaseResources = undefined;
      this.publication = undefined;
      this.update({ status: 'idle', stream: undefined, audioGuidance: undefined });
      if (signal.aborted) return;
      throw error;
    }
  }

  async stop(): Promise<void> {
    ++this.startRequest;
    // A pending grant can outlive local cancellation. Keep it as a restart
    // barrier without making Leave wait on an unbounded network request.
    if (this.stopPromise) return this.stoppingStartup ? undefined : this.stopPromise;
    const stream = this.activeStream ?? this.state.stream;
    const abort = this.startAbort;
    const cancelCapture = () => {
      this.endedCleanup?.(); this.endedCleanup = undefined;
      this.activeStream = undefined;
      this.stopTracks?.(); this.stopTracks = undefined;
      if (abort && !abort.signal.aborted) {
        abort.abort(); this.dependencies.cancelPendingCapture?.();
      }
    };
    if (!this.publication && this.state.status === 'starting') {
      const work = this.startWork;
      const barrier = (work?.catch(() => undefined) ?? Promise.resolve()).finally(() => {
        if (this.stopPromise === barrier) { this.stopPromise = undefined; this.stoppingStartup = false; }
      });
      this.stoppingStartup = true;
      this.stopPromise = barrier;
      cancelCapture();
      this.update({ status: 'idle', stream: undefined, audioGuidance: undefined });
      return;
    }
    if (!stream) return;
    const publication = this.publication;
    const releaseResources = this.releaseResources;
    this.stopPromise = (publication?.catch(() => undefined) ?? Promise.resolve())
      .then(() => releaseResources?.())
      .finally(() => {
        if (this.publication === publication) this.publication = undefined;
        if (this.releaseResources === releaseResources) this.releaseResources = undefined;
        this.stopPromise = undefined;
        this.update({ status: 'idle', stream: undefined, audioGuidance: undefined });
      });
    cancelCapture();
    this.update({ status: 'stopping', stream: undefined, audioGuidance: undefined });
    return this.stopPromise;
  }

  getState(): ScreenShareState { return { ...this.state }; }

  subscribe(listener: (state: ScreenShareState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private async verifyOwnAudioRestriction(track: MediaStreamTrack): Promise<boolean> {
    if (isAndroidPlaybackAudioTrack(track)) return true;
    if (!this.dependencies.supportsOwnAudioRestriction()) return false;
    try {
      await track.applyConstraints({
        restrictOwnAudio: { exact: true }
      } as MediaTrackConstraints & {
        restrictOwnAudio: { exact: boolean };
      });
      return (track.getSettings() as MediaTrackSettings & { restrictOwnAudio?: boolean }).restrictOwnAudio === true;
    } catch {
      return false;
    }
  }

  private update(change: Partial<ScreenShareState>): void {
    this.state = { ...this.state, ...change };
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }
}
export interface HybridScreenSharePublisherDependencies {
  /** LiveKit (SFU) publisher used for the fallback path. */
  sfuPublisher: ScreenSharePublisher;
  /** Current online viewer roster (from the signaling client's welcome/peer events). */
  getViewers: () => Peer[];
  /** Creates the P2P share controller for a session (bound to the page signaling client). */
  createShareController: (deps: {
    onViewerFallback: (identity: string) => void;
    onAllViewersClosed: () => void;
  }) => P2pShareController;
  /** SFU fallback bitrate ceiling; defaults to 10 Mbps (the existing default tier). */
  sfuFallbackBitrate?: number;
  /** Fired synchronously once the P2P controller exists, so signaling events can be routed to it. */
  onControllerCreated?: (controller: P2pShareController) => void;
  onViewerStatesChanged?: (states: ReadonlyMap<string, ViewerSessionState>) => void;
}

export interface ScreenSharePublishOptions {
  nativeCapture?: boolean;
  encodingPreference?: 'hardware' | 'compatible';
  encodingEngine?: 'project' | 'browser';
  maxBitrate: number;
  frameRate: number;
  degradationPreference: RTCDegradationPreference;
  codec: ScreenShareCodec;
}

/**
 * Screen sharing starts on P2P/TURN. LiveKit exists only while at least one
 * viewer explicitly requests SFU; failures never create a backup publication.
 */
export class HybridScreenSharePublisher implements ScreenSharePublisher {
  private readonly sfuFallbackBitrate: number;
  private activeStream?: MediaStream;
  private activeOptions?: ScreenSharePublishOptions;
  private shareController?: P2pShareController;
  private unsubscribeController?: () => void;
  private publishedSfuStream?: MediaStream;
  private readonly sfuViewers = new Set<string>();
  private readonly transportRevisions = new Map<string, number>();
  private nextTransportRevision = 0;
  private viewerStates = new Map<string, ViewerSessionState>();
  private sfuTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: HybridScreenSharePublisherDependencies) {
    this.sfuFallbackBitrate = deps.sfuFallbackBitrate ?? sfuScreenShareFallbackBitrate;
  }

  /** The active P2P controller, used to route signaling answer/ice/bye events. */
  getShareController(): P2pShareController | undefined {
    return this.shareController;
  }

  async publish(stream: MediaStream, options: ScreenSharePublishOptions): Promise<void> {
    this.activeStream = stream;
    this.activeOptions = options;
    const viewers = this.deps.getViewers();
    if (viewers.length === 0) return;
    const controller = this.ensureController();
    try {
      await controller.start(stream, options, viewers);
    } catch {
      // Keep the capture available for a P2P retry or explicit SFU request.
    }
  }

  async release(stream: MediaStream): Promise<void> {
    if (this.activeStream !== undefined && this.activeStream !== stream) return;
    const controller = this.shareController;
    this.shareController = undefined;
    this.unsubscribeController?.();
    this.unsubscribeController = undefined;
    this.activeStream = undefined;
    this.activeOptions = undefined;
    this.sfuViewers.clear();
    this.transportRevisions.clear();
    this.viewerStates.clear();
    if (controller) await controller.stop();
    await this.reconcileSfu();
  }

  /** The roster changed; a reconnect welcome also refreshes incomplete ICE generations. */
  viewerRosterChanged(recoverNegotiating = false): void {
    if (this.activeStream === undefined) return;
    const viewers = this.deps.getViewers();
    for (const identity of this.sfuViewers) {
      if (!viewers.some((viewer) => viewer.identity === identity)) this.sfuViewers.delete(identity);
    }
    void this.reconcileSfu().catch(() => undefined);
    if (viewers.length === 0) return;
    const controller = this.ensureController();
    void controller.start(this.activeStream, this.activeOptions!, viewers.filter((viewer) => !this.sfuViewers.has(viewer.identity)), recoverNegotiating).catch(() => undefined);
  }

  /** A viewer left (`peer-left`): drop them from fallback tracking and close their session. */
  viewerLeft(identity: string): void {
    this.sfuViewers.delete(identity);
    this.transportRevisions.delete(identity);
    this.viewerStates.delete(identity);
    this.shareController?.handleViewerLeft(identity);
    this.emitViewerStates();
    void this.reconcileSfu().catch(() => undefined);
  }

  /** A viewer ended its peer session; this never requests an SFU publication. */
  handleViewerBye(identity: string, reason?: string): void {
    void reason;
    this.shareController?.handleViewerLeft(identity);
  }

  async setViewerScreenTransport(identity: string, transport: 'peer' | 'sfu'): Promise<void> {
    const stream = this.activeStream;
    if (!stream) return;
    const revision = ++this.nextTransportRevision;
    this.transportRevisions.set(identity, revision);
    if (transport === 'sfu') {
      this.sfuViewers.add(identity);
      this.shareController?.handleViewerLeft(identity);
    } else {
      this.sfuViewers.delete(identity);
    }
    this.emitViewerStates();
    await this.reconcileSfu();
    if (transport === 'peer' && this.activeStream === stream && this.activeOptions
      && this.transportRevisions.get(identity) === revision && !this.sfuViewers.has(identity)
      && this.deps.getViewers().some((viewer) => viewer.identity === identity)) {
      if (this.shareController) this.shareController.handleRetry(identity);
      else await this.ensureController().start(stream, this.activeOptions, this.deps.getViewers().filter((viewer) => !this.sfuViewers.has(viewer.identity)));
    }
  }

  private emitViewerStates(): void {
    const states = new Map(this.viewerStates);
    for (const [identity, state] of states) {
      if (state === 'livekit-fallback') states.set(identity, 'negotiating');
    }
    for (const identity of this.sfuViewers) states.set(identity, 'livekit-fallback');
    this.deps.onViewerStatesChanged?.(states);
  }

  private ensureController(): P2pShareController {
    if (this.shareController === undefined) {
      const controller = this.deps.createShareController({
        onViewerFallback: () => undefined,
        // Closed viewer sessions keep the active stream/options on the
        // controller so a viewer can request a fresh TURN/P2P offer after an
        // SFU fallback. Full controller shutdown belongs to share release.
        onAllViewersClosed: () => undefined
      });
      this.shareController = controller;
      this.unsubscribeController = controller.subscribe((states) => {
        this.viewerStates = new Map(states);
        this.emitViewerStates();
      });
      this.deps.onControllerCreated?.(controller);
    }
    return this.shareController;
  }

  private reconcileSfu(): Promise<void> {
    return this.queueSfu(async () => {
      const stream = this.activeStream;
      if (stream && this.sfuViewers.size > 0 && !this.publishedSfuStream) {
        await this.deps.sfuPublisher.publish(stream, this.sfuOptions());
        this.publishedSfuStream = stream;
      }
      if (this.publishedSfuStream && (this.activeStream !== this.publishedSfuStream || this.sfuViewers.size === 0)) {
        const published = this.publishedSfuStream;
        await this.deps.sfuPublisher.release(published);
        this.publishedSfuStream = undefined;
      }
    });
  }

  private sfuOptions(): ScreenSharePublishOptions {
    const options = this.activeOptions;
    if (!options) throw new Error('Screen sharing is not active.');
    return { ...options, maxBitrate: Math.min(options.maxBitrate, this.sfuFallbackBitrate) };
  }

  /** Serializes SFU publish/release so the track state stays consistent under races. */
  private queueSfu(operation: () => Promise<void>): Promise<void> {
    const run = this.sfuTail.then(operation);
    this.sfuTail = run.catch(() => undefined);
    return run;
  }
}

export function createScreenShareController(dependencies: {
  requestGrant(): Promise<void>;
  releaseGrant(): Promise<void>;
  getDisplayMedia?: (constraints: DisplayMediaStreamOptions, signal?: AbortSignal) => Promise<MediaStream>;
  cancelPendingCapture?: () => void;
  supportsOwnAudioRestriction?: () => boolean;
  chooseUnrestrictedSystemAudio?: (
    context: { displaySurface: string }
  ) => Promise<UnrestrictedSystemAudioChoice>;
  publisher: ScreenSharePublisher;
}): ScreenShareController {
  const getDisplayMedia = dependencies.getDisplayMedia
    ?? ((constraints: DisplayMediaStreamOptions) => navigator.mediaDevices.getDisplayMedia(constraints));
  const supportsOwnAudioRestriction = dependencies.supportsOwnAudioRestriction
    ?? (() => (navigator.mediaDevices?.getSupportedConstraints?.() as (MediaTrackSupportedConstraints & {
      restrictOwnAudio?: boolean;
    }) | undefined)?.restrictOwnAudio === true);
  const chooseUnrestrictedSystemAudio = dependencies.chooseUnrestrictedSystemAudio
    ?? (async () => 'share-audio' as const);
  return new BrowserScreenShareController({
    ...dependencies,
    getDisplayMedia,
    supportsOwnAudioRestriction,
    chooseUnrestrictedSystemAudio
  });
}
