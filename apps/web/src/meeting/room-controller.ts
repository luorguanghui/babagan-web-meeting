import type { JoinMeetingResponse } from '@meeting/contracts';
import {
  Room,
  RoomEvent,
  Track,
  supportsAudioOutputSelection,
  type AudioCaptureOptions,
  type RoomConnectOptions,
  type RoomOptions
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

export interface MeetingRoomState {
  connection: MeetingConnectionState;
  participants: MeetingParticipant[];
  microphoneEnabled: boolean;
  audioPlaybackBlocked: boolean;
}

export interface MeetingRoomController {
  connect(join: JoinMeetingResponse): Promise<void>;
  setMicrophoneEnabled(enabled: boolean, deviceId?: string): Promise<void>;
  switchAudioOutput(deviceId: string): Promise<'changed' | 'unsupported'>;
  disconnect(): Promise<void>;
  subscribe(listener: (state: MeetingRoomState) => void): () => void;
  resumeAudioPlayback(): Promise<void>;
}

export interface LiveKitParticipantAdapter {
  identity: string;
  name?: string;
  isMicrophoneEnabled: boolean;
  isScreenShareEnabled: boolean;
  setMicrophoneEnabled?(enabled: boolean, options?: AudioCaptureOptions): Promise<unknown>;
}

export interface LiveKitTrackAdapter {
  kind: string;
  attach(): HTMLMediaElement;
  detach(): HTMLMediaElement | HTMLMediaElement[];
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
    audioPlaybackBlocked: false
  };
  private readonly listeners = new Set<(state: MeetingRoomState) => void>();
  private readonly roomListeners = new Map<string, (...args: unknown[]) => void>();
  private selectedMicrophoneId?: string;

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
      this.refreshParticipants();
      this.update({ connection: 'connected' });
    } catch (reason) {
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
    this.listen(room, RoomEvent.Reconnecting, () => this.update({ connection: 'reconnecting' }));
    this.listen(room, RoomEvent.Reconnected, () => this.update({ connection: 'connected' }));
    this.listen(room, RoomEvent.Disconnected, () => this.releaseRoom(room));
    this.listen(room, RoomEvent.TrackSubscribed, (value) => {
      const track = value as LiveKitTrackAdapter;
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach();
      element.autoplay = true;
      element.hidden = true;
      document.body.append(element);
      void this.audioPlayback.add(element).catch(() => undefined);
    });
    this.listen(room, RoomEvent.TrackUnsubscribed, (value) => {
      const detached = (value as LiveKitTrackAdapter).detach();
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
    for (const [event, listener] of this.roomListeners) room.off(event, listener);
    this.roomListeners.clear();
    this.audioPlayback.clear();
    this.room = undefined;
    this.update({ connection: 'disconnected', participants: [], microphoneEnabled: false });
  }

  private refreshParticipants(): void {
    if (!this.room) return;
    const local = this.room.localParticipant;
    const participants = [this.toParticipant(local, true), ...[...this.room.remoteParticipants.values()].map((participant) => this.toParticipant(participant, false))];
    this.update({ participants, microphoneEnabled: local.isMicrophoneEnabled });
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
    return { ...this.state, participants: this.state.participants.map((participant) => ({ ...participant })) };
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
