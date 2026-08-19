import type { JoinMeetingResponse, ScreenShareCodec } from '@meeting/contracts';
import {
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  supportsAudioOutputSelection,
  type AudioCaptureOptions,
  type RoomConnectOptions,
  type RoomOptions,
  type TrackPublishOptions
} from 'livekit-client';

import { AudioPlayback } from './audio-playback.js';

export type MeetingConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface MeetingParticipant {
  identity: string;
  name: string;
  isLocal: boolean;
  microphoneEnabled: boolean;
  isSharing: boolean;
}

export interface RemoteScreenShare {
  track: LiveKitTrackAdapter;
  audioTrack?: LiveKitTrackAdapter;
  sharerIdentity: string;
  sharerName: string;
}

export interface MeetingRoomState {
  connection: MeetingConnectionState;
  participants: MeetingParticipant[];
  microphoneEnabled: boolean;
  audioPlaybackBlocked: boolean;
  screenShareAuthorized: boolean;
  remoteScreenShare?: RemoteScreenShare;
}

export interface MeetingRoomController {
  connect(join: JoinMeetingResponse): Promise<void>;
  setMicrophoneEnabled(enabled: boolean, deviceId?: string): Promise<void>;
  switchAudioOutput(deviceId: string): Promise<'changed' | 'unsupported'>;
  publishScreenShare(stream: MediaStream, options: {
    maxBitrate: number;
    frameRate: number;
    degradationPreference: RTCDegradationPreference;
    codec: ScreenShareCodec;
  }): Promise<void>;
  releaseScreenShare(stream: MediaStream): Promise<void>;
  setRemoteScreenShareSubscribed(subscribed: boolean): Promise<void>;
  getScreenShareStatsReports?(): Promise<RTCStatsReport[]>;
  disconnect(): Promise<void>;
  subscribe(listener: (state: MeetingRoomState) => void): () => void;
  resumeAudioPlayback(): Promise<void>;
}

export interface LiveKitParticipantAdapter {
  identity: string;
  name?: string;
  isMicrophoneEnabled: boolean;
  isScreenShareEnabled: boolean;
  permissions?: { canPublishSources?: number[] };
  setMicrophoneEnabled?(enabled: boolean, options?: AudioCaptureOptions): Promise<unknown>;
  publishTrack?(track: MediaStreamTrack, options?: TrackPublishOptions): Promise<unknown>;
  unpublishTrack?(track: MediaStreamTrack, stopOnUnpublish?: boolean): Promise<unknown>;
  trackPublications?: Map<string, LiveKitTrackPublicationAdapter>;
}

export interface LiveKitTrackAdapter {
  kind: string;
  mediaStreamTrack?: MediaStreamTrack;
  attach(element?: HTMLMediaElement): HTMLMediaElement;
  detach(element?: HTMLMediaElement): HTMLMediaElement | HTMLMediaElement[];
  setPlayoutDelay?(delayInSeconds: number): void;
  getRTCStatsReport?(): Promise<RTCStatsReport | undefined>;
}

interface LiveKitLocalPublicationAdapter {
  track?: { getRTCStatsReport?(): Promise<RTCStatsReport | undefined> };
}

export interface LiveKitTrackPublicationAdapter {
  source?: string;
  setSubscribed?(subscribed: boolean): void;
}

export interface LiveKitRoomAdapter {
  connect(url: string, token: string, options?: RoomConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  remoteParticipants: Map<string, LiveKitParticipantAdapter>;
  localParticipant: LiveKitParticipantAdapter;
  switchActiveDevice(kind: MediaDeviceKind, deviceId: string): Promise<boolean>;
}

export type LiveKitRoomFactory = (options: RoomOptions) => LiveKitRoomAdapter;

const voiceConstraints: AudioCaptureOptions = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
};

const screenSharePlayoutDelaySeconds = 0.5;
const screenShareFallback = new VideoPreset(1280, 720, 3_500_000, 30, 'medium');
const e2eFakeLiveKitPublication = import.meta.env.VITE_E2E_FAKE_LIVEKIT === 'true';
/**
 * Safety net for participant-state display: LiveKit state events can be
 * missed (tracks arriving before subscription, reconnect windows, dynacast
 * pauses), so the local snapshot refreshes on this interval to converge the
 * mic/share indicators.
 */
const PARTICIPANT_REFRESH_INTERVAL_MS = 5_000;

class RoomController implements MeetingRoomController {
  private room?: LiveKitRoomAdapter;
  private state: MeetingRoomState = {
    connection: 'disconnected',
    participants: [],
    microphoneEnabled: false,
    audioPlaybackBlocked: false,
    screenShareAuthorized: false
  };
  private readonly listeners = new Set<(state: MeetingRoomState) => void>();
  private readonly roomListeners = new Map<string, (...args: unknown[]) => void>();
  private roomGeneration = 0;
  private selectedMicrophoneId?: string;
  private publishedScreenTracks: MediaStreamTrack[] = [];
  private localScreenStatsSources: Array<{ getRTCStatsReport?(): Promise<RTCStatsReport | undefined> }> = [];
  private readonly remoteScreenAudioTracks = new Map<string, LiveKitTrackAdapter>();
  private participantRefreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly createRoom: LiveKitRoomFactory,
    private readonly audioPlayback: AudioPlayback,
    private readonly supportsAudioOutput: () => boolean
  ) {
    this.audioPlayback.subscribe((blocked) => {
      this.state = { ...this.state, audioPlaybackBlocked: blocked };
      this.emit();
    });
  }

  async connect(join: JoinMeetingResponse): Promise<void> {
    if (this.room) await this.disconnect();
    const generation = ++this.roomGeneration;
    const room = this.createRoom({
      adaptiveStream: { pixelDensity: 'screen' },
      dynacast: true,
      audioCaptureDefaults: voiceConstraints
    });
    this.room = room;
    this.bindRoomEvents(room);
    this.update({ connection: 'connecting' });
    try {
      await room.connect(join.livekitUrl, join.token, { autoSubscribe: true });
      if (!this.ownsRoom(room, generation)) return;
      this.refreshParticipants();
      this.startParticipantRefresh();
      this.update({ connection: 'connected' });
    } catch (reason) {
      if (!this.ownsRoom(room, generation)) return;
      this.releaseRoom(room);
      await room.disconnect().catch(() => undefined);
      throw reason;
    }
  }

  async setMicrophoneEnabled(enabled: boolean, deviceId?: string): Promise<void> {
    if (!this.room?.localParticipant.setMicrophoneEnabled) throw new Error('The meeting room is not connected.');
    if (deviceId) this.selectedMicrophoneId = deviceId;
    await this.room.localParticipant.setMicrophoneEnabled(enabled, {
      ...voiceConstraints,
      ...(this.selectedMicrophoneId ? { deviceId: { exact: this.selectedMicrophoneId } } : {})
    });
    this.refreshParticipants();
  }

  async switchAudioOutput(deviceId: string): Promise<'changed' | 'unsupported'> {
    if (!this.room) throw new Error('The meeting room is not connected.');
    if (!this.supportsAudioOutput()) return 'unsupported';
    await this.room.switchActiveDevice('audiooutput', deviceId);
    return 'changed';
  }

  async publishScreenShare(
    stream: MediaStream,
    options: {
      maxBitrate: number;
      frameRate: number;
      degradationPreference: RTCDegradationPreference;
      codec: ScreenShareCodec;
    }
  ): Promise<void> {
    // The local Playwright harness has no LiveKit process. Its dedicated build
    // flag preserves the publish-before-P2P call while replacing only the SDK
    // publication side effect; production builds compile this branch false.
    if (e2eFakeLiveKitPublication) {
      this.publishedScreenTracks = stream.getTracks();
      return;
    }
    const participant = this.room?.localParticipant;
    if (!participant?.publishTrack || !participant.unpublishTrack) {
      throw new Error('The meeting room is not connected for screen sharing.');
    }
    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) throw new Error('Screen sharing requires a video track.');
    const tracks: Array<{ track: MediaStreamTrack; options: TrackPublishOptions }> = [{
      track: videoTrack,
      options: {
        source: Track.Source.ScreenShare,
        stream: 'screen-share',
        simulcast: true,
        backupCodec: false,
        screenShareEncoding: { maxBitrate: options.maxBitrate, maxFramerate: options.frameRate },
        screenShareSimulcastLayers: [screenShareFallback],
        degradationPreference: options.degradationPreference,
        ...(options.codec === 'auto' ? {} : { videoCodec: options.codec })
      }
    }, ...stream.getAudioTracks().map((track) => ({
      track,
      options: { source: Track.Source.ScreenShareAudio, stream: 'screen-share' }
    }))];
    const published: MediaStreamTrack[] = [];
    try {
      for (const value of tracks) {
        const publication = await participant.publishTrack(value.track, value.options) as LiveKitLocalPublicationAdapter | undefined;
        published.push(value.track);
        if (publication?.track) this.localScreenStatsSources.push(publication.track);
      }
      this.publishedScreenTracks = published;
    } catch (error) {
      await Promise.allSettled(published.map((track) => participant.unpublishTrack!(track, false)));
      this.localScreenStatsSources = [];
      throw error;
    }
  }

  async releaseScreenShare(stream: MediaStream): Promise<void> {
    if (e2eFakeLiveKitPublication) {
      const owned = new Set(stream.getTracks());
      this.publishedScreenTracks = this.publishedScreenTracks.filter((track) => !owned.has(track));
      return;
    }
    const participant = this.room?.localParticipant;
    if (!participant?.unpublishTrack) return;
    const owned = new Set(stream.getTracks());
    const tracks = this.publishedScreenTracks.filter((track) => owned.has(track));
    this.publishedScreenTracks = this.publishedScreenTracks.filter((track) => !owned.has(track));
    await Promise.allSettled(tracks.map((track) => participant.unpublishTrack!(track, true)));
    this.localScreenStatsSources = [];
    this.refreshParticipants();
  }

  async setRemoteScreenShareSubscribed(subscribed: boolean): Promise<void> {
    const room = this.room;
    if (!room) throw new Error('The meeting room is not connected.');
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications?.values() ?? []) {
        if (publication.source === Track.Source.ScreenShare
          || publication.source === Track.Source.ScreenShareAudio) {
          publication.setSubscribed?.(subscribed);
        }
      }
    }
  }

  async getScreenShareStatsReports(): Promise<RTCStatsReport[]> {
    const sources = [
      ...this.localScreenStatsSources,
      ...(this.state.remoteScreenShare
        ? [this.state.remoteScreenShare.track, this.state.remoteScreenShare.audioTrack].filter(Boolean)
        : [])
    ];
    const reports = await Promise.all(sources.map((source) => source?.getRTCStatsReport?.()));
    return reports.filter((report): report is RTCStatsReport => Boolean(report));
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.releaseRoom(room);
    await room.disconnect();
  }

  subscribe(listener: (state: MeetingRoomState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async resumeAudioPlayback(): Promise<void> {
    await this.audioPlayback.resume();
  }

  private bindRoomEvents(room: LiveKitRoomAdapter): void {
    const refresh = () => this.refreshParticipants();
    this.listen(room, RoomEvent.ParticipantConnected, refresh);
    this.listen(room, RoomEvent.ParticipantDisconnected, refresh);
    this.listen(room, RoomEvent.ParticipantNameChanged, refresh);
    // Mic/share state arrives through several events: a track can be
    // published (muted or not) before it is subscribed, and dynacast can
    // pause/resume subscriptions without a mute transition, so every track
    // lifecycle signal refreshes the snapshot instead of only mute events.
    this.listen(room, RoomEvent.TrackPublished, refresh);
    this.listen(room, RoomEvent.TrackUnpublished, refresh);
    this.listen(room, RoomEvent.TrackMuted, refresh);
    this.listen(room, RoomEvent.TrackUnmuted, refresh);
    this.listen(room, RoomEvent.TrackSubscriptionStatusChanged, refresh);
    this.listen(room, RoomEvent.TrackSubscriptionPermissionChanged, refresh);
    this.listen(room, RoomEvent.LocalTrackPublished, refresh);
    this.listen(room, RoomEvent.LocalTrackUnpublished, refresh);
    this.listen(room, RoomEvent.ParticipantPermissionsChanged, refresh);
    this.listen(room, RoomEvent.Reconnecting, () => this.update({ connection: 'reconnecting' }));
    this.listen(room, RoomEvent.Reconnected, () => this.update({ connection: 'connected' }));
    this.listen(room, RoomEvent.Disconnected, () => this.releaseRoom(room));
    this.listen(room, RoomEvent.TrackSubscribed, (value, publicationValue, participantValue) => {
      const track = value as LiveKitTrackAdapter;
      const publication = publicationValue as LiveKitTrackPublicationAdapter;
      const participant = participantValue as LiveKitParticipantAdapter;
      if (track.kind === Track.Kind.Video
        && publication.source === Track.Source.ScreenShare) {
        track.setPlayoutDelay?.(screenSharePlayoutDelaySeconds);
        this.update({
          remoteScreenShare: {
            track,
            audioTrack: this.remoteScreenAudioTracks.get(participant.identity),
            sharerIdentity: participant.identity,
            sharerName: participant.name?.trim() || participant.identity
          }
        });
        return;
      }
      if (track.kind !== Track.Kind.Audio) return;
      if (publication?.source === Track.Source.ScreenShareAudio) {
        track.setPlayoutDelay?.(screenSharePlayoutDelaySeconds);
        this.remoteScreenAudioTracks.set(participant.identity, track);
        if (this.state.remoteScreenShare?.sharerIdentity === participant.identity) {
          this.update({
            remoteScreenShare: { ...this.state.remoteScreenShare, audioTrack: track }
          });
        }
        return;
      }
      const element = track.attach();
      element.autoplay = true;
      element.hidden = true;
      document.body.append(element);
      void this.audioPlayback.add(element).catch(() => undefined);
    });
    this.listen(room, RoomEvent.TrackUnsubscribed, (value, publicationValue, participantValue) => {
      const track = value as LiveKitTrackAdapter;
      const publication = publicationValue as LiveKitTrackPublicationAdapter;
      const participant = participantValue as LiveKitParticipantAdapter;
      if (track.kind === Track.Kind.Video && publication.source === Track.Source.ScreenShare) {
        if (this.state.remoteScreenShare?.sharerIdentity === participant.identity) {
          this.update({ remoteScreenShare: undefined });
        }
        return;
      }
      if (track.kind === Track.Kind.Audio && publication?.source === Track.Source.ScreenShareAudio) {
        this.remoteScreenAudioTracks.delete(participant.identity);
        if (this.state.remoteScreenShare?.sharerIdentity === participant.identity
          && this.state.remoteScreenShare.audioTrack === track) {
          const { track: videoTrack, sharerIdentity, sharerName } = this.state.remoteScreenShare;
          this.update({
            remoteScreenShare: { track: videoTrack, sharerIdentity, sharerName }
          });
        }
        return;
      }
      const detached = track.detach();
      for (const element of Array.isArray(detached) ? detached : [detached]) this.audioPlayback.remove(element);
    });
  }

  private listen(room: LiveKitRoomAdapter, event: string, listener: (...args: unknown[]) => void): void {
    const guardedListener = (...args: unknown[]) => {
      if (this.room === room) listener(...args);
    };
    this.roomListeners.set(event, guardedListener);
    room.on(event, guardedListener);
  }

  private releaseRoom(room: LiveKitRoomAdapter): void {
    if (this.room !== room) return;
    this.roomGeneration++;
    for (const [event, listener] of this.roomListeners) room.off(event, listener);
    this.roomListeners.clear();
    this.stopParticipantRefresh();
    this.audioPlayback.clear();
    this.publishedScreenTracks = [];
    this.localScreenStatsSources = [];
    this.remoteScreenAudioTracks.clear();
    this.room = undefined;
    this.update({
      connection: 'disconnected',
      participants: [],
      microphoneEnabled: false,
      screenShareAuthorized: false,
      remoteScreenShare: undefined
    });
  }

  private startParticipantRefresh(): void {
    this.stopParticipantRefresh();
    this.participantRefreshTimer = setInterval(
      () => this.refreshParticipants(),
      PARTICIPANT_REFRESH_INTERVAL_MS
    );
  }

  private stopParticipantRefresh(): void {
    if (this.participantRefreshTimer !== undefined) {
      clearInterval(this.participantRefreshTimer);
      this.participantRefreshTimer = undefined;
    }
  }

  private ownsRoom(room: LiveKitRoomAdapter, generation: number): boolean {
    return this.room === room && this.roomGeneration === generation;
  }

  private refreshParticipants(): void {
    if (!this.room) return;
    const local = this.room.localParticipant;
    const participants = [this.toParticipant(local, true), ...[...this.room.remoteParticipants.values()].map((participant) => this.toParticipant(participant, false))];
    this.update({
      participants,
      microphoneEnabled: local.isMicrophoneEnabled,
      screenShareAuthorized: local.permissions?.canPublishSources?.includes(3) ?? false
    });
  }

  private toParticipant(participant: LiveKitParticipantAdapter, isLocal: boolean): MeetingParticipant {
    return {
      identity: participant.identity,
      name: participant.name?.trim() || participant.identity,
      isLocal,
      microphoneEnabled: participant.isMicrophoneEnabled,
      isSharing: participant.isScreenShareEnabled
    };
  }

  private update(change: Partial<MeetingRoomState>): void {
    this.state = { ...this.state, ...change };
    this.emit();
  }

  private snapshot(): MeetingRoomState {
    return {
      ...this.state,
      participants: this.state.participants.map((participant) => ({ ...participant })),
      ...(this.state.remoteScreenShare
        ? { remoteScreenShare: { ...this.state.remoteScreenShare } }
        : {})
    };
  }

  private emit(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}

const defaultRoomFactory: LiveKitRoomFactory = (options) => new Room(options) as unknown as LiveKitRoomAdapter;

export function createRoomController(
  createRoom: LiveKitRoomFactory = defaultRoomFactory,
  dependencies: { audioPlayback?: AudioPlayback; supportsAudioOutput?: () => boolean } = {}
): MeetingRoomController {
  return new RoomController(
    createRoom,
    dependencies.audioPlayback ?? new AudioPlayback(),
    dependencies.supportsAudioOutput ?? supportsAudioOutputSelection
  );
}
