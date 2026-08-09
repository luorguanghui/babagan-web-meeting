export const captureProfiles = {
  standard: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 8_000_000,
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution'
  },
  motion: {
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 10_000_000,
    contentHint: 'motion',
    degradationPreference: 'maintain-framerate'
  }
} as const;

export type CaptureProfile = keyof typeof captureProfiles;
export type ScreenShareStatus = 'idle' | 'starting' | 'sharing';
export type UnrestrictedSystemAudioChoice = 'share-audio' | 'video-only' | 'cancel';

export interface ScreenShareState {
  status: ScreenShareStatus;
  profile: CaptureProfile;
  stream?: MediaStream;
  audioGuidance?: string;
}

export interface ScreenSharePublisher {
  publish(stream: MediaStream, options: {
    maxBitrate: number;
    frameRate: number;
    degradationPreference: RTCDegradationPreference;
  }): Promise<void>;
  release(stream: MediaStream): Promise<void>;
}

export interface ScreenShareController {
  start(profile: CaptureProfile): Promise<void>;
  stop(): Promise<void>;
  getState(): ScreenShareState;
  subscribe(listener: (state: ScreenShareState) => void): () => void;
}

const audioGuidance = 'No computer audio was shared. In Chrome or Edge, choose a browser tab and enable “Share tab audio”, or choose Entire screen and enable system audio in the share picker.';
const videoOnlyGuidance = 'The screen is being shared without computer audio because the browser could not prevent meeting echo.';
const unrestrictedAudioGuidance = 'The browser could not isolate meeting playback from system audio. You chose to continue with the echo risk.';
const tabAudioGuidance = 'Screen sharing was cancelled. Choose a browser tab and enable “Share tab audio” for isolated content audio.';

class BrowserScreenShareController implements ScreenShareController {
  private state: ScreenShareState = { status: 'idle', profile: 'standard' };
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

  async start(profile: CaptureProfile): Promise<void> {
    if (this.state.status !== 'idle') throw new Error('Screen sharing is already active.');
    const settings = captureProfiles[profile];
    let grantAcquired = false;
    let stream: MediaStream | undefined;
    let shareAudioGuidance: string | undefined;
    this.update({ status: 'starting', profile, stream: undefined, audioGuidance: undefined });
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
            this.update({ status: 'idle', profile, stream: undefined, audioGuidance: tabAudioGuidance });
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
        maxBitrate: settings.maxBitrate,
        frameRate: settings.frameRate,
        degradationPreference: settings.degradationPreference
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
        profile,
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
      this.update({ status: 'idle', profile, stream: undefined, audioGuidance: undefined });
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
