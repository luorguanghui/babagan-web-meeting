import { P2P_SCREEN_BITRATES, type P2pScreenBitrate, type ScreenShareCodec } from '@meeting/contracts';

import type { P2pShareController, ViewerSessionState } from './p2p-share-controller.js';
import type { Peer } from './p2p-signaling.js';

export const adaptiveCaptureProfile = {
  width: 1920,
  height: 1080,
  frameRate: 60,
  contentHint: 'detail',
  degradationPreference: 'maintain-resolution'
} as const;

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
  start(codec?: ScreenShareCodec, maxBitrate?: ScreenShareBitrate): Promise<void>;
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
  private endedTrack?: MediaStreamTrack;
  private activeStream?: MediaStream;
  private publication?: Promise<void>;
  private stopPromise?: Promise<void>;

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
    maxBitrate: ScreenShareBitrate = screenShareDefaultBitrate
  ): Promise<void> {
    if (this.state.status !== 'idle') throw new Error('Screen sharing is already active.');
    const settings = adaptiveCaptureProfile;
    let grantAcquired = false;
    let stream: MediaStream | undefined;
    let shareAudioGuidance: string | undefined;
    this.update({ status: 'starting', stream: undefined, audioGuidance: undefined });
    try {
      await this.dependencies.requestGrant();
      grantAcquired = true;
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
      videoTrack.contentHint = settings.contentHint;
      this.activeStream = stream;
      this.endedTrack = videoTrack;
      videoTrack.addEventListener('ended', this.handleEnded, { once: true });
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
      if (stream && this.activeStream !== stream && this.stopPromise) {
        await this.stopPromise;
        return;
      }
      this.activeStream = undefined;
      this.publication = undefined;
      this.endedTrack?.removeEventListener('ended', this.handleEnded);
      for (const track of stream?.getTracks() ?? []) track.stop();
      await Promise.allSettled([
        ...(stream ? [this.dependencies.publisher.release(stream)] : []),
        ...(grantAcquired ? [this.dependencies.releaseGrant()] : [])
      ]);
      this.endedTrack = undefined;
      this.update({ status: 'idle', stream: undefined, audioGuidance: undefined });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const stream = this.activeStream ?? this.state.stream;
    if (!stream) {
      this.update({ status: 'idle', stream: undefined, audioGuidance: undefined });
      return;
    }
    this.endedTrack?.removeEventListener('ended', this.handleEnded);
    this.endedTrack = undefined;
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

  getState(): ScreenShareState { return { ...this.state }; }

  subscribe(listener: (state: ScreenShareState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private readonly handleEnded = () => { void this.stop(); };

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
 * P2P-first screen share publisher: a share starts over direct peer-to-peer
 * connections (one `RTCPeerConnection` per online viewer) and the LiveKit/SFU
 * screen track is published only as a fallback:
 *
 * - Any viewer whose P2P session is `livekit-fallback` (detected sharer-side
 *   or reported via a `bye` with reason `fallback`) turns the SFU track on.
 * - The SFU track turns off again once every tracked viewer is confirmed on a
 *   healthy P2P session (set is empty) or has left.
 * - A share started with no online viewers skips P2P and goes straight to the
 *   SFU path (existing behavior), so late joiners keep receiving it.
 *
 * The publisher never publishes two sources for the same viewer: a viewer on a
 * `p2p` session is never in the fallback set, and `p2p`/`livekit-fallback` are
 * terminal per-session states that only a fresh session (rejoin or re-drive)
 * can leave, at which point the fallback set is re-evaluated.
 */
export class HybridScreenSharePublisher implements ScreenSharePublisher {
  private readonly sfuFallbackBitrate: number;
  private activeStream?: MediaStream;
  private activeOptions?: ScreenSharePublishOptions;
  private shareController?: P2pShareController;
  private unsubscribeController?: () => void;
  private controllerStates: ReadonlyMap<string, ViewerSessionState> = new Map();
  private readonly fallbackViewers = new Set<string>();
  private sfuPublished = false;
  private sfuOnlyStart = false;
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
    if (viewers.length === 0) {
      // No online viewers: keep the existing SFU path so late joiners see the share.
      await this.publishSfu(stream);
      this.sfuOnlyStart = true;
      return;
    }
    const controller = this.ensureController();
    try {
      await controller.start(stream, options.maxBitrate as P2pScreenBitrate, viewers);
    } catch {
      // P2P unavailable (e.g. ICE credentials endpoint): fall back to the SFU path.
      await this.publishSfu(stream);
      this.sfuOnlyStart = true;
    }
  }

  async release(stream: MediaStream): Promise<void> {
    const controller = this.shareController;
    this.shareController = undefined;
    this.unsubscribeController?.();
    this.unsubscribeController = undefined;
    this.controllerStates = new Map();
    this.fallbackViewers.clear();
    this.activeStream = undefined;
    this.activeOptions = undefined;
    this.sfuOnlyStart = false;
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
    void controller.start(
      this.activeStream,
      this.activeOptions!.maxBitrate as P2pScreenBitrate,
      viewers
    ).catch(() => undefined);
  }

  /** A viewer left (`peer-left`): drop them from fallback tracking and close their session. */
  viewerLeft(identity: string): void {
    this.fallbackViewers.delete(identity);
    this.shareController?.handleViewerLeft(identity);
    this.syncLiveKit();
  }

  /** A `bye` arrived from a viewer; a `fallback` bye means they need the SFU track. */
  handleViewerBye(identity: string, reason?: string): void {
    if (reason === 'fallback') this.noteViewerFallback(identity);
    this.shareController?.handleViewerLeft(identity);
  }

  private ensureController(): P2pShareController {
    if (this.shareController === undefined) {
      const controller = this.deps.createShareController({
        onViewerFallback: (identity) => this.noteViewerFallback(identity),
        onAllViewersClosed: () => {
          // Every tracked viewer is gone: clear the P2P sessions; the share
          // itself stays active and re-drives if a viewer joins again.
          if (this.activeStream !== undefined) void this.shareController?.stop();
        }
      });
      this.shareController = controller;
      this.unsubscribeController = controller.subscribe((states) => this.onControllerStates(states));
      this.deps.onControllerCreated?.(controller);
    }
    return this.shareController;
  }

  private noteViewerFallback(identity: string): void {
    if (!this.fallbackViewers.has(identity)) {
      this.fallbackViewers.add(identity);
      this.syncLiveKit();
    }
  }

  private onControllerStates(states: ReadonlyMap<string, ViewerSessionState>): void {
    this.controllerStates = states;
    // A viewer whose (fresh) session reached `p2p` no longer needs the SFU track.
    for (const identity of [...this.fallbackViewers]) {
      if (states.get(identity) === 'p2p') this.fallbackViewers.delete(identity);
    }
    this.syncLiveKit();
  }

  private livekitNeeded(): boolean {
    if (this.fallbackViewers.size > 0) return true;
    if (!this.sfuOnlyStart) return false;
    // SFU-only start: keep broadcasting until every online viewer is on P2P.
    const roster = this.deps.getViewers();
    if (roster.length === 0) return true; // still no viewers: keep the existing SFU behavior
    return roster.some((viewer) => this.controllerStates.get(viewer.identity) !== 'p2p');
  }

  private syncLiveKit(): void {
    if (this.activeStream === undefined) return;
    const stream = this.activeStream;
    const needed = this.livekitNeeded();
    if (needed && !this.sfuPublished) {
      this.sfuPublished = true;
      void this.queueSfu(() => this.deps.sfuPublisher.publish(stream, this.sfuOptions()))
        .catch(() => { this.sfuPublished = false; });
    } else if (!needed && this.sfuPublished) {
      this.sfuPublished = false;
      void this.queueSfu(() => this.deps.sfuPublisher.release(stream)).catch(() => undefined);
    }
  }

  private publishSfu(stream: MediaStream): Promise<void> {
    this.sfuPublished = true;
    return this.queueSfu(() => this.deps.sfuPublisher.publish(stream, this.sfuOptions()))
      .catch(() => { this.sfuPublished = false; });
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
