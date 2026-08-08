import type { JoinMeetingResponse } from '@meeting/contracts';
import {
  Room,
  RoomEvent,
  Track,
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
  stream: MediaStream;
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
  publishScreenShare(stream: MediaStream, options: { maxBitrate: number; frameRate: number }): Promise<void>;
  releaseScreenShare(stream: MediaStream): Promise<void>;
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
}

export interface LiveKitTrackAdapter {
  kind: string;
  mediaStreamTrack?: MediaStreamTrack;
  attach(): HTMLMediaElement;
  detach(): HTMLMediaElement | HTMLMediaElement[];
}

interface LiveKitTrackPublicationAdapter {
  source?: string;
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
      adaptiveStream: true,
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
    options: { maxBitrate: number; frameRate: number }
  ): Promise<void> {
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
        videoEncoding: { maxBitrate: options.maxBitrate, maxFramerate: options.frameRate }
      }
    }, ...stream.getAudioTracks().map((track) => ({
      track,
      options: { source: Track.Source.ScreenShareAudio, stream: 'screen-share' }
    }))];
    const published: MediaStreamTrack[] = [];
    try {
      for (const value of tracks) {
        await participant.publishTrack(value.track, value.options);
        published.push(value.track);
      }
      this.publishedScreenTracks = published;
    } catch (error) {
      await Promise.allSettled(published.map((track) => participant.unpublishTrack!(track, false)));
      throw error;
    }
  }

  async releaseScreenShare(stream: MediaStream): Promise<void> {
    const participant = this.room?.localParticipant;
    if (!participant?.unpublishTrack) return;
    const owned = new Set(stream.getTracks());
    const tracks = this.publishedScreenTracks.filter((track) => owned.has(track));
    this.publishedScreenTracks = this.publishedScreenTracks.filter((track) => !owned.has(track));
    await Promise.allSettled(tracks.map((track) => participant.unpublishTrack!(track, true)));
    this.refreshParticipants();
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
    this.listen(room, RoomEvent.TrackMuted, refresh);
    this.listen(room, RoomEvent.TrackUnmuted, refresh);
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
        && publication.source === Track.Source.ScreenShare
        && track.mediaStreamTrack) {
        this.update({
          remoteScreenShare: {
            stream: new MediaStream([track.mediaStreamTrack]),
            sharerIdentity: participant.identity,
            sharerName: participant.name?.trim() || participant.identity
          }
        });
        return;
      }
      if (track.kind !== Track.Kind.Audio) return;
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
    this.audioPlayback.clear();
    this.publishedScreenTracks = [];
    this.room = undefined;
    this.update({
      connection: 'disconnected',
      participants: [],
      microphoneEnabled: false,
      screenShareAuthorized: false,
      remoteScreenShare: undefined
    });
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
