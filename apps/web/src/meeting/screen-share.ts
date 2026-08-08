export const captureProfiles = {
  standard: { width: 1920, height: 1080, frameRate: 30, maxBitrate: 8_000_000 },
  motion: { width: 1920, height: 1080, frameRate: 60, maxBitrate: 15_000_000 }
} as const;

export type CaptureProfile = keyof typeof captureProfiles;
export type ScreenShareStatus = 'idle' | 'starting' | 'sharing';

export interface ScreenShareState {
  status: ScreenShareStatus;
  profile: CaptureProfile;
  stream?: MediaStream;
  audioGuidance?: string;
}

export interface ScreenSharePublisher {
  publish(stream: MediaStream, options: { maxBitrate: number; frameRate: number }): Promise<void>;
  release(stream: MediaStream): Promise<void>;
}

export interface ScreenShareController {
  start(profile: CaptureProfile): Promise<void>;
  stop(): Promise<void>;
  getState(): ScreenShareState;
  subscribe(listener: (state: ScreenShareState) => void): () => void;
}

const audioGuidance = 'No computer audio was shared. In Chrome or Edge, choose a browser tab and enable “Share tab audio”, or choose Entire screen and enable system audio.';

class BrowserScreenShareController implements ScreenShareController {
  private state: ScreenShareState = { status: 'idle', profile: 'standard' };
  private readonly listeners = new Set<(state: ScreenShareState) => void>();
  private endedTrack?: MediaStreamTrack;
  private stopPromise?: Promise<void>;

  constructor(private readonly dependencies: {
    requestGrant(): Promise<void>;
    releaseGrant(): Promise<void>;
    getDisplayMedia(constraints: DisplayMediaStreamOptions): Promise<MediaStream>;
    publisher: ScreenSharePublisher;
  }) {}

  async start(profile: CaptureProfile): Promise<void> {
    if (this.state.status !== 'idle') throw new Error('Screen sharing is already active.');
    const settings = captureProfiles[profile];
    let grantAcquired = false;
    let stream: MediaStream | undefined;
    this.update({ status: 'starting', profile, stream: undefined, audioGuidance: undefined });
    try {
      await this.dependencies.requestGrant();
      grantAcquired = true;
      stream = await this.dependencies.getDisplayMedia({
        video: { width: settings.width, height: settings.height, frameRate: settings.frameRate },
        audio: true
      });
      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack) throw new Error('The selected source did not provide a video track.');
      await this.dependencies.publisher.publish(stream, {
        maxBitrate: settings.maxBitrate,
        frameRate: settings.frameRate
      });
      this.endedTrack = videoTrack;
      videoTrack.addEventListener('ended', this.handleEnded, { once: true });
      this.update({
        status: 'sharing',
        profile,
        stream,
        audioGuidance: stream.getAudioTracks().length === 0 ? audioGuidance : undefined
      });
    } catch (error) {
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
    const stream = this.state.stream;
    if (!stream) {
      this.update({ status: 'idle', stream: undefined, audioGuidance: undefined });
      return;
    }
    this.endedTrack?.removeEventListener('ended', this.handleEnded);
    this.endedTrack = undefined;
    this.update({ status: 'idle', stream: undefined, audioGuidance: undefined });
    for (const track of stream.getTracks()) track.stop();
    this.stopPromise = Promise.allSettled([
      this.dependencies.publisher.release(stream),
      this.dependencies.releaseGrant()
    ]).then(() => undefined).finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }

  getState(): ScreenShareState { return { ...this.state }; }

  subscribe(listener: (state: ScreenShareState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private readonly handleEnded = () => { void this.stop(); };

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
  publisher: ScreenSharePublisher;
}): ScreenShareController {
  const getDisplayMedia = dependencies.getDisplayMedia
    ?? ((constraints: DisplayMediaStreamOptions) => navigator.mediaDevices.getDisplayMedia(constraints));
  return new BrowserScreenShareController({ ...dependencies, getDisplayMedia });
}
