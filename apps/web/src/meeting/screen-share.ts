import {
  P2P_SCREEN_BITRATES,
  type P2pScreenBitrate,
  type ScreenShareCodec,
  type ScreenShareQuality
} from '@meeting/contracts';

import type { P2pShareController } from './p2p-share-controller.js';
import type { Peer } from './p2p-signaling.js';

export interface ScreenShareQualityPreset {
  width: number;
  height: number;
  frameRate: number;
  degradationPreference: RTCDegradationPreference;
}

/**
 * Screen-share quality presets applied to both the SFU fallback and the P2P
 * path. All presets capture at 60 fps; the difference is how the encoder
 * degrades under bandwidth pressure. `flow` and `standard` are
 * frame-rate-first (`maintain-framerate` drops resolution before frame rate,
 * keeping the stream smooth); `motion` keeps the picture crisp and drops
 * frames only when the network forces it.
 */
export const screenShareQualityPresets: Record<ScreenShareQuality, ScreenShareQualityPreset> = {
  flow: { width: 1280, height: 720, frameRate: 60, degradationPreference: 'maintain-framerate' },
  standard: { width: 1920, height: 1080, frameRate: 60, degradationPreference: 'maintain-framerate' },
  motion: { width: 1920, height: 1080, frameRate: 60, degradationPreference: 'maintain-resolution' }
};

export const screenShareDefaultQuality: ScreenShareQuality = 'standard';
export const screenShareContentHint = 'detail' as const;

/**
 * P2P screen-share bitrate tiers (contracts constants): the direct peer-to-peer
 * path is the preferred share path, so the user-facing selector offers these.
 */
export const screenShareBitrates = P2P_SCREEN_BITRATES;
export type ScreenShareBitrate = P2pScreenBitrate;
/** Default P2P bitrate. */
export const screenShareDefaultBitrate = 8_000_000;
/**
 * Suggested P2P bitrate for the number of online viewers: 8 Mbps for up to
 * three viewers, 5 Mbps from four on. The suggestion is applied as the default
 * selection before sharing and can still be overridden manually.
 */
export function recommendP2pBitrate(viewerCount: number): ScreenShareBitrate {
  return viewerCount >= 4 ? 5_000_000 : 8_000_000;
}

/** SFU (LiveKit) fallback bitrate tiers, kept from the pre-P2P implementation. */
export const sfuScreenShareBitrates = [10_000_000, 13_000_000, 15_000_000] as const;
/** Bitrate ceiling used when the share runs over the SFU fallback path. */
export const sfuScreenShareFallbackBitrate = 10_000_000;

export type ScreenShareStatus = 'idle' | 'starting' | 'sharing';
export type UnrestrictedSystemAudioChoice = 'share-audio' | 'video-only' | 'cancel';

export interface ScreenShareState {
  status: ScreenShareStatus;
  stream?: MediaStream;
  audioGuidance?: string;
}

export interface ScreenSharePublisher {
  publish(stream: MediaStream, options: {
    maxBitrate: number;
    frameRate: number;
    degradationPreference: RTCDegradationPreference;
    codec: ScreenShareCodec;
  }): Promise<void>;
  release(stream: MediaStream): Promise<void>;
}

export interface ScreenShareController {
  start(
    codec?: ScreenShareCodec,
    maxBitrate?: ScreenShareBitrate,
    quality?: ScreenShareQuality
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
  /** Set by `stop()` while a start is still in flight (grant/capture/audio decision). */
  private cancelRequested = false;
  /** Monotonic generation of `start()`; a start that is no longer current must abort. */
  private startGen = 0;
  /** Removes the current start's `ended` listener; the newer start owns this slot. */
  private endedCleanup?: () => void;

  constructor(private readonly dependencies: {
    requestGrant(): Promise<void>;
    releaseGrant(): Promise<void>;
    getDisplayMedia(constraints: DisplayMediaStreamOptions): Promise<MediaStream>;
    supportsOwnAudioRestriction(): boolean;
    chooseUnrestrictedSystemAudio(context: { displaySurface: string }): Promise<UnrestrictedSystemAudioChoice>;
    publisher: ScreenSharePublisher;
  }) {}

  async start(
    codec: ScreenShareCodec = 'h264',
    maxBitrate: ScreenShareBitrate = screenShareDefaultBitrate,
    quality: ScreenShareQuality = screenShareDefaultQuality
  ): Promise<void> {
    if (this.state.status !== 'idle') throw new Error('Screen sharing is already active.');
    const myGen = ++this.startGen;
    this.cancelRequested = false;
    const settings = screenShareQualityPresets[quality];
    let grantAcquired = false;
    let stream: MediaStream | undefined;
    let shareAudioGuidance: string | undefined;
    this.update({ status: 'starting', stream: undefined, audioGuidance: undefined });
    try {
      await this.dependencies.requestGrant();
      grantAcquired = true;
      if (this.cancelRequested || this.startGen !== myGen) {
        // Revoked or superseded while the grant was in flight.
        await this.cancelStart(undefined, grantAcquired);
        return;
      }
      stream = await this.dependencies.getDisplayMedia({
        video: { width: settings.width, height: settings.height, frameRate: settings.frameRate },
        audio: { restrictOwnAudio: true } as MediaTrackConstraints & {
          restrictOwnAudio: boolean;
        },
        systemAudio: 'include',
        windowAudio: 'window',
        selfBrowserSurface: 'exclude'
      } as DisplayMediaStreamOptions & {
        systemAudio: 'include';
        windowAudio: 'window';
        selfBrowserSurface: 'exclude';
      });
      if (this.cancelRequested || this.startGen !== myGen) {
        // Revoked or superseded while the source picker was open.
        await this.cancelStart(stream, grantAcquired);
        return;
      }
      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack) throw new Error('The selected source did not provide a video track.');
      const displaySurface = videoTrack.getSettings?.().displaySurface;
      const [audioTrack] = stream.getAudioTracks();
      if (audioTrack) {
        const ownAudioRestricted = await this.verifyOwnAudioRestriction(audioTrack);
        if ((displaySurface === 'monitor' || displaySurface === 'window') && !ownAudioRestricted) {
          const choice = await this.dependencies.chooseUnrestrictedSystemAudio({ displaySurface });
          if (choice === 'cancel') {
            for (const track of stream.getTracks()) track.stop();
            await Promise.allSettled([this.dependencies.releaseGrant()]);
            grantAcquired = false;
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
      if (this.cancelRequested || this.startGen !== myGen) {
        // Revoked or superseded while the system-audio decision was pending.
        await this.cancelStart(stream, grantAcquired);
        return;
      }
      // Normalize the capture resolution: display scaling can make the browser
      // capture at odd logical sizes (e.g. 1536x864 on a 125%-scaled 1080p
      // screen), which would then transmit unchanged on both the direct P2P
      // and the SFU path. The preset dimensions are ideal — the browser keeps
      // the native size when the display cannot provide more — so the shared
      // picture settles on a standard tier instead.
      await (typeof videoTrack.applyConstraints === 'function'
        ? videoTrack.applyConstraints({
          width: { ideal: settings.width },
          height: { ideal: settings.height },
          frameRate: { ideal: settings.frameRate }
        }).catch(() => undefined)
        : undefined);
      videoTrack.contentHint = screenShareContentHint;
      this.activeStream = stream;
      const onEnded = () => {
        // Only the current start's ended track may stop the share; a
        // superseded start's track ending must not tear down a newer share.
        if (this.startGen === myGen) void this.stop();
      };
      videoTrack.addEventListener('ended', onEnded, { once: true });
      this.endedCleanup = () => videoTrack.removeEventListener('ended', onEnded);
      const publication = Promise.resolve().then(() => this.dependencies.publisher.publish(stream!, {
        maxBitrate,
        frameRate: settings.frameRate,
        degradationPreference: settings.degradationPreference,
        codec
      }));
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
      if (!superseded && stream && this.activeStream !== stream && this.stopPromise) {
        await this.stopPromise;
        return;
      }
      for (const track of stream?.getTracks() ?? []) track.stop();
      await Promise.allSettled([
        // Only the current start may release the publication: it could belong
        // to a newer start that superseded this one.
        ...(stream && !superseded ? [this.dependencies.publisher.release(stream)] : []),
        ...(grantAcquired ? [this.dependencies.releaseGrant()] : [])
      ]);
      if (superseded) {
        // A superseded start fails silently: a newer start owns the state machine.
        return;
      }
      this.endedCleanup?.();
      this.endedCleanup = undefined;
      this.activeStream = undefined;
      this.publication = undefined;
      this.update({ status: 'idle', stream: undefined, audioGuidance: undefined });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.cancelRequested = true;
    const stream = this.activeStream ?? this.state.stream;
    if (!stream) {
      this.update({ status: 'idle', stream: undefined, audioGuidance: undefined });
      return;
    }
    this.endedCleanup?.();
    this.endedCleanup = undefined;
    this.activeStream = undefined;
    this.update({ status: 'idle', stream: undefined, audioGuidance: undefined });
    for (const track of stream.getTracks()) track.stop();
    const publication = this.publication;
    this.stopPromise = (publication?.catch(() => undefined) ?? Promise.resolve())
      .then(() => Promise.allSettled([
        this.dependencies.publisher.release(stream),
        this.dependencies.releaseGrant()
      ]))
      .then(() => undefined)
      .finally(() => {
        if (this.publication === publication) this.publication = undefined;
        this.stopPromise = undefined;
      });
    return this.stopPromise;
  }

  /**
   * Aborts a start that was stopped or superseded while still in the
   * `starting` window (grant in flight, source picker open, or audio decision
   * pending). Only releases resources owned by this start: its acquired
   * tracks and its grant. The state machine is left untouched — `stop()` (or
   * the superseding start) already owns it.
   */
  private async cancelStart(stream: MediaStream | undefined, grantAcquired: boolean): Promise<void> {
    for (const track of stream?.getTracks() ?? []) track.stop();
    await Promise.allSettled([
      ...(grantAcquired ? [this.dependencies.releaseGrant()] : [])
    ]);
  }

  getState(): ScreenShareState { return { ...this.state }; }

  subscribe(listener: (state: ScreenShareState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private async verifyOwnAudioRestriction(track: MediaStreamTrack): Promise<boolean> {
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
}

export interface ScreenSharePublishOptions {
  maxBitrate: number;
  frameRate: number;
  degradationPreference: RTCDegradationPreference;
  codec: ScreenShareCodec;
}

/**
 * Hybrid screen-share publisher. LiveKit is published first and stays active
 * for the full share as a compatibility and recovery safety net. P2P-capable
 * viewers may unsubscribe their own LiveKit screen publications only after
 * direct media is rendering; the sharer never removes the fallback globally.
 */
export class HybridScreenSharePublisher implements ScreenSharePublisher {
  private readonly sfuFallbackBitrate: number;
  private activeStream?: MediaStream;
  private activeOptions?: ScreenSharePublishOptions;
  private shareController?: P2pShareController;
  private unsubscribeController?: () => void;
  private sfuPublished = false;
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
    await this.publishSfu(stream);
    const viewers = this.deps.getViewers();
    if (viewers.length === 0) return;
    const controller = this.ensureController();
    try {
      await controller.start(stream, options, viewers);
    } catch {
      // LiveKit is already carrying the share; P2P remains a best-effort path.
    }
  }

  async release(stream: MediaStream): Promise<void> {
    const controller = this.shareController;
    this.shareController = undefined;
    this.unsubscribeController?.();
    this.unsubscribeController = undefined;
    this.activeStream = undefined;
    this.activeOptions = undefined;
    if (controller) await controller.stop();
    if (this.sfuPublished) {
      this.sfuPublished = false;
      await this.queueSfu(() => this.deps.sfuPublisher.release(stream)).catch(() => undefined);
    }
  }

  /** The roster changed (welcome/peer-joined): re-drive P2P with the fresh roster. */
  viewerRosterChanged(): void {
    if (this.activeStream === undefined) return;
    const viewers = this.deps.getViewers();
    if (viewers.length === 0) return;
    const controller = this.ensureController();
    void controller.start(this.activeStream, this.activeOptions!, viewers).catch(() => undefined);
  }

  /** A viewer left (`peer-left`): drop them from fallback tracking and close their session. */
  viewerLeft(identity: string): void {
    this.shareController?.handleViewerLeft(identity);
  }

  /** A `bye` arrived from a viewer; a `fallback` bye means they need the SFU track. */
  handleViewerBye(identity: string, reason?: string): void {
    void reason;
    this.shareController?.handleViewerLeft(identity);
  }

  private ensureController(): P2pShareController {
    if (this.shareController === undefined) {
      const controller = this.deps.createShareController({
        onViewerFallback: () => undefined,
        onAllViewersClosed: () => {
          // Every tracked viewer is gone: clear the P2P sessions; the share
          // itself stays active and re-drives if a viewer joins again.
          if (this.activeStream !== undefined) void this.shareController?.stop();
        }
      });
      this.shareController = controller;
      this.unsubscribeController = controller.subscribe(() => undefined);
      this.deps.onControllerCreated?.(controller);
    }
    return this.shareController;
  }

  private async publishSfu(stream: MediaStream): Promise<void> {
    await this.queueSfu(() => this.deps.sfuPublisher.publish(stream, this.sfuOptions()));
    this.sfuPublished = true;
  }

  private sfuOptions(): ScreenSharePublishOptions {
    const options = this.activeOptions;
    if (!options) throw new Error('Screen sharing is not active.');
    return { ...options, maxBitrate: this.sfuFallbackBitrate };
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
  getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
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
