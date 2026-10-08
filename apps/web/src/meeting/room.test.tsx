import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JoinMeetingResponse } from '@meeting/contracts';

import { MeetingRoomPage } from '../pages/meeting-room-page.js';
import { AudioPlayback } from './audio-playback.js';
import {
  createRoomController,
  type LiveKitRoomAdapter,
  type MeetingParticipant,
  type MeetingRoomController,
  type MeetingRoomState
} from './room-controller.js';

const join: JoinMeetingResponse = {
  participantIdentity: 'participant-local',
  participantName: 'Ada',
  livekitUrl: 'wss://rtc.example',
  token: 'participant-token',
  meetingExpiresAt: 1_800_000_000_000,
  permissions: { publishSources: ['microphone'] }
};

afterEach(() => {
  cleanup();
  document.querySelectorAll('audio').forEach((element) => element.remove());
  window.localStorage.removeItem('babagan.viewer-transport');
  vi.unstubAllGlobals();
});

function roomAdapter(): LiveKitRoomAdapter {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    remoteParticipants: new Map(),
    localParticipant: {
      identity: join.participantIdentity,
      name: join.participantName,
      isMicrophoneEnabled: false,
      isScreenShareEnabled: false,
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined)
    },
    switchActiveDevice: vi.fn().mockResolvedValue(true)
  };
}

function remotePublications(room: LiveKitRoomAdapter) {
  const screenVideo = { source: 'screen_share', setSubscribed: vi.fn() };
  const screenAudio = { source: 'screen_share_audio', setSubscribed: vi.fn() };
  const microphone = { source: 'microphone', setSubscribed: vi.fn() };
  const camera = { source: 'camera', setSubscribed: vi.fn() };
  room.remoteParticipants.set('participant-2', {
    identity: 'participant-2', name: 'Ben',
    isMicrophoneEnabled: true, isScreenShareEnabled: true,
    trackPublications: new Map([
      ['screen-video', screenVideo], ['screen-audio', screenAudio],
      ['microphone', microphone], ['camera', camera]
    ])
  });
  return { screenVideo, screenAudio, microphone, camera };
}

describe('room controller', () => {
  it('leaves remote screen publications unsubscribed while receiving voice and other tracks', async () => {
    const room = roomAdapter();
    const { screenVideo, screenAudio, microphone, camera } = remotePublications(room);
    const participant = room.remoteParticipants.get('participant-2')!;
    room.remoteParticipants.clear();
    vi.mocked(room.connect).mockImplementation(async () => {
      room.remoteParticipants.set('participant-2', participant);
    });
    const controller = createRoomController(() => room);
    await controller.connect(join);

    expect(screenVideo.setSubscribed).toHaveBeenCalledWith(false);
    expect(screenAudio.setSubscribed).toHaveBeenCalledWith(false);
    expect(microphone.setSubscribed).toHaveBeenCalledWith(true);
    expect(camera.setSubscribed).toHaveBeenCalledWith(true);
  });

  it('toggles only remote LiveKit screen-share publications when the viewing transport changes', async () => {
    const room = roomAdapter();
    const { screenVideo, screenAudio, microphone } = remotePublications(room);
    const controller = createRoomController(() => room);
    await controller.connect(join);
    microphone.setSubscribed.mockClear();

    await controller.setRemoteScreenShareSubscribed(true);
    expect(screenVideo.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(screenAudio.setSubscribed).toHaveBeenLastCalledWith(true);
    await controller.setRemoteScreenShareSubscribed(false);

    expect(screenVideo.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(screenAudio.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(microphone.setSubscribed).not.toHaveBeenCalled();
  });

  it('keeps a screen subscription choice made before connecting across replacement rooms', async () => {
    const firstRoom = roomAdapter();
    const nextRoom = roomAdapter();
    const first = remotePublications(firstRoom);
    const next = remotePublications(nextRoom);
    const rooms = [firstRoom, nextRoom];
    const controller = createRoomController(() => rooms.shift()!);

    await controller.setRemoteScreenShareSubscribed(true);
    await controller.connect(join);
    await controller.connect(join);

    expect(first.screenVideo.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(first.screenAudio.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(next.screenVideo.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(next.screenAudio.setSubscribed).toHaveBeenLastCalledWith(true);
  });

  it('applies the current choice to later screen publications and subscribes later microphones', async () => {
    const room = roomAdapter();
    const controller = createRoomController(() => room);
    await controller.connect(join);
    const published = vi.mocked(room.on).mock.calls.find(([event]: [string, unknown]) => event === 'trackPublished')![1];
    const screenVideo = { source: 'screen_share', setSubscribed: vi.fn() };
    const screenAudio = { source: 'screen_share_audio', setSubscribed: vi.fn() };
    const microphone = { source: 'microphone', setSubscribed: vi.fn() };

    published(screenVideo);
    published(screenAudio);
    published(microphone);

    expect(screenVideo.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(screenAudio.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(microphone.setSubscribed).toHaveBeenLastCalledWith(true);

    await controller.setRemoteScreenShareSubscribed(true);
    published(screenVideo);
    published(screenAudio);
    expect(screenVideo.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(screenAudio.setSubscribed).toHaveBeenLastCalledWith(true);
  });

  it.each([false, true])('reconciles restored publications after SDK reconnection with screen choice %s', async (subscribed: boolean) => {
    const room = roomAdapter();
    const controller = createRoomController(() => room);
    await controller.setRemoteScreenShareSubscribed(subscribed);
    await controller.connect(join);
    const restored = remotePublications(room);
    const reconnected = vi.mocked(room.on).mock.calls.find(([event]: [string, unknown]) => event === 'reconnected')![1];

    reconnected();

    expect(restored.screenVideo.setSubscribed).toHaveBeenLastCalledWith(subscribed);
    expect(restored.screenAudio.setSubscribed).toHaveBeenLastCalledWith(subscribed);
    expect(restored.microphone.setSubscribed).toHaveBeenLastCalledWith(true);
  });

  it('ignores late screen subscription events and keeps microphone audio playing', async () => {
    const room = roomAdapter();
    const controller = createRoomController(() => room);
    const states: MeetingRoomState[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.connect(join);
    const subscribed = vi.mocked(room.on).mock.calls.find(([event]: [string, unknown]) => event === 'trackSubscribed')![1];
    const participant = { identity: 'participant-2', name: 'Ben' };
    const video = { kind: 'video', attach: vi.fn(), detach: vi.fn() };
    const audio = { kind: 'audio', attach: vi.fn(), detach: vi.fn() };
    const screenVideo = { source: 'screen_share', setSubscribed: vi.fn() };
    const screenAudio = { source: 'screen_share_audio', setSubscribed: vi.fn() };
    const voiceElement = document.createElement('audio');
    vi.spyOn(voiceElement, 'play').mockResolvedValue(undefined);

    subscribed(video, screenVideo, participant);
    subscribed(audio, screenAudio, participant);
    subscribed({ kind: 'audio', attach: () => voiceElement, detach: () => voiceElement }, { source: 'microphone' }, participant);

    expect(states.at(-1)?.remoteScreenShare).toBeUndefined();
    expect(screenVideo.setSubscribed).toHaveBeenCalledWith(false);
    expect(screenAudio.setSubscribed).toHaveBeenCalledWith(false);
    expect(audio.attach).not.toHaveBeenCalled();
    expect(voiceElement).toBeInTheDocument();

    await controller.setRemoteScreenShareSubscribed(true);
    subscribed(video, screenVideo, participant);
    expect(states.at(-1)?.remoteScreenShare).toMatchObject({ track: video });
    expect(states.at(-1)?.remoteScreenShare?.audioTrack).toBeUndefined();

    await controller.setRemoteScreenShareSubscribed(false);
    expect(voiceElement).toBeInTheDocument();
    controller.setCallAudioVolume(0.4);
    expect(voiceElement.volume).toBe(0.4);
  });

  it('clears the current screen and shared audio immediately when screen reception is disabled', async () => {
    const room = roomAdapter();
    const controller = createRoomController(() => room);
    const states: MeetingRoomState[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.connect(join);
    await controller.setRemoteScreenShareSubscribed(true);
    const subscribed = vi.mocked(room.on).mock.calls.find(([event]: [string, unknown]) => event === 'trackSubscribed')![1];
    const participant = { identity: 'participant-2', name: 'Ben' };
    const video = { kind: 'video', attach: vi.fn(), detach: vi.fn() };
    const audio = { kind: 'audio', attach: vi.fn(), detach: vi.fn() };
    subscribed(video, { source: 'screen_share' }, participant);
    subscribed(audio, { source: 'screen_share_audio' }, participant);
    expect(states.at(-1)?.remoteScreenShare?.audioTrack).toBe(audio);

    await controller.setRemoteScreenShareSubscribed(false);
    expect(states.at(-1)?.remoteScreenShare).toBeUndefined();
    await controller.setRemoteScreenShareSubscribed(true);
    subscribed(video, { source: 'screen_share' }, participant);
    expect(states.at(-1)?.remoteScreenShare?.audioTrack).toBeUndefined();
  });

  it('connects with subscription optimizations while keeping the local microphone muted', async () => {
    const room = roomAdapter();
    const createRoom = vi.fn(() => room);
    const controller = createRoomController(createRoom);

    await controller.connect(join);

    expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({
      adaptiveStream: { pixelDensity: 'screen' },
      dynacast: true,
      audioCaptureDefaults: expect.objectContaining({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      })
    }));
    expect(room.connect).toHaveBeenCalledWith(join.livekitUrl, join.token, expect.objectContaining({ autoSubscribe: false }));
    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it('enforces voice constraints whenever a member enables a selected microphone', async () => {
    const room = roomAdapter();
    const controller = createRoomController(() => room);
    await controller.connect(join);

    await controller.setMicrophoneEnabled(true, 'microphone-2');

    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, {
      deviceId: { exact: 'microphone-2' },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    });
  });

  it('remembers a microphone selected while muted for the next unmute', async () => {
    const room = roomAdapter();
    const controller = createRoomController(() => room);
    await controller.connect(join);

    await controller.setMicrophoneEnabled(false, 'microphone-2');
    await controller.setMicrophoneEnabled(true);

    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true, expect.objectContaining({
      deviceId: { exact: 'microphone-2' }
    }));
  });

  it('publishes a local-first roster with independent remote microphone states', async () => {
    const room = roomAdapter();
    room.remoteParticipants.set('participant-2', {
      identity: 'participant-2', name: 'Ben', isMicrophoneEnabled: true, isScreenShareEnabled: false
    });
    const controller = createRoomController(() => room);
    const states: MeetingRoomState[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.connect(join);

    expect(states.at(-1)).toMatchObject({
      connection: 'connected',
      microphoneEnabled: false,
      participants: [
        { identity: join.participantIdentity, isLocal: true, microphoneEnabled: false },
        { identity: 'participant-2', isLocal: false, microphoneEnabled: true }
      ]
    });
  });

  it('reports unsupported speaker switching without touching the room', async () => {
    const room = roomAdapter();
    const controller = createRoomController(() => room, { supportsAudioOutput: () => false });
    await controller.connect(join);

    await expect(controller.switchAudioOutput('speaker-2')).resolves.toBe('unsupported');
    expect(room.switchActiveDevice).not.toHaveBeenCalled();
  });

  it('refreshes participant states periodically so missed mute events converge', async () => {
    vi.useFakeTimers();
    try {
      const room = roomAdapter();
      const controller = createRoomController(() => room);
      const states: MeetingRoomState[] = [];
      controller.subscribe((state) => states.push(state));
      await controller.connect(join);
      expect(states.at(-1)?.microphoneEnabled).toBe(false);

      // A state change with no event (or an event lost to a reconnect window)
      // must still converge through the periodic snapshot refresh.
      room.localParticipant.isMicrophoneEnabled = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(states.at(-1)?.microphoneEnabled).toBe(true);

      await controller.disconnect();
      const snapshotCount = states.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(states.length).toBe(snapshotCount); // refresh timer was cleared
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnects the SDK room and clears the participant roster', async () => {
    const room = roomAdapter();
    const controller = createRoomController(() => room);
    const states: MeetingRoomState[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.connect(join);

    await controller.disconnect();

    expect(room.disconnect).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({ connection: 'disconnected', participants: [] });
  });

  it('clears stale participants when the SDK reports an unexpected disconnect', async () => {
    const room = roomAdapter();
    room.remoteParticipants.set('participant-2', {
      identity: 'participant-2', name: 'Ben', isMicrophoneEnabled: true, isScreenShareEnabled: false
    });
    const controller = createRoomController(() => room);
    const states: MeetingRoomState[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.connect(join);
    const disconnected = vi.mocked(room.on).mock.calls.find(([event]: [string, unknown]) => event === 'disconnected')?.[1];

    disconnected?.();

    expect(states.at(-1)).toMatchObject({ connection: 'disconnected', participants: [], microphoneEnabled: false });
  });

  it('fully releases the SDK room after a failed connection attempt', async () => {
    const room = roomAdapter();
    vi.mocked(room.connect).mockRejectedValue(new Error('SFU unavailable'));
    const controller = createRoomController(() => room);

    await expect(controller.connect(join)).rejects.toThrow('SFU unavailable');

    expect(room.off).toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalledOnce();
    await expect(controller.setMicrophoneEnabled(true)).rejects.toThrow('not connected');
    await expect(controller.switchAudioOutput('speaker-2')).rejects.toThrow('not connected');
  });

  it('does not restore a connected room after meeting UI unmounts during a pending SDK connect', async () => {
    let resolveConnect!: () => void;
    const room = roomAdapter();
    vi.mocked(room.connect).mockImplementation(() => new Promise<void>((resolve) => { resolveConnect = resolve; }));
    const controller = createRoomController(() => room);
    const states: MeetingRoomState[] = [];
    controller.subscribe((state) => states.push(state));
    const rendered = render(<MeetingRoomPage
      slug="meeting-slug" join={join} controller={controller} listDevices={async () => []}
      meetingApi={{
        authorizeHost: async () => { throw new Error('not host'); }, verifyParticipantShare: async () => undefined,
        grantShare: async () => undefined, releaseOwnShare: async () => undefined, revokeShare: async () => undefined,
        kick: async () => undefined, end: async () => undefined
      }}
    />);
    await waitFor(() => expect(states.at(-1)?.connection).toBe('connecting'));
    rendered.unmount();
    resolveConnect();
    await Promise.resolve();

    expect(states.at(-1)?.connection).toBe('disconnected');
    expect(room.disconnect).toHaveBeenCalledOnce();
  });

  it('fully releases the SDK room after an unexpected disconnect event', async () => {
    const room = roomAdapter();
    const controller = createRoomController(() => room);
    await controller.connect(join);
    const disconnected = vi.mocked(room.on).mock.calls.find(([event]: [string, unknown]) => event === 'disconnected')?.[1];

    disconnected?.();

    expect(room.off).toHaveBeenCalled();
    await expect(controller.setMicrophoneEnabled(true)).rejects.toThrow('not connected');
    await expect(controller.switchAudioOutput('speaker-2')).rejects.toThrow('not connected');
  });

  it('surfaces an attached remote audio autoplay rejection in room state', async () => {
    const room = roomAdapter();
    const playback = new AudioPlayback();
    const controller = createRoomController(() => room, { audioPlayback: playback });
    const states: MeetingRoomState[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.connect(join);
    const element = document.createElement('audio');
    vi.spyOn(element, 'play').mockRejectedValue(new DOMException('Blocked', 'NotAllowedError'));
    const subscribed = vi.mocked(room.on).mock.calls.find(([event]: [string, unknown]) => event === 'trackSubscribed')?.[1];

    subscribed?.({ kind: 'audio', attach: () => element, detach: () => element });

    await waitFor(() => expect(states.at(-1)?.audioPlaybackBlocked).toBe(true));
  });

  it('keeps the receiver call volume for microphone tracks after reconnecting', async () => {
    const firstRoom = roomAdapter();
    const reconnectedRoom = roomAdapter();
    const rooms = [firstRoom, reconnectedRoom];
    const controller = createRoomController(() => rooms.shift()!);
    await controller.connect(join);
    controller.setCallAudioVolume(0.4);
    await controller.connect(join);
    const element = document.createElement('audio');
    vi.spyOn(element, 'play').mockResolvedValue(undefined);
    const subscribed = vi.mocked(reconnectedRoom.on).mock.calls
      .find(([event]: [string, unknown]) => event === 'trackSubscribed')?.[1];

    subscribed?.(
      { kind: 'audio', attach: () => element, detach: () => element },
      { source: 'microphone' },
      { identity: 'participant-2', name: 'Ben' }
    );

    await waitFor(() => expect(element.volume).toBe(0.4));
  });
});

const participants: MeetingParticipant[] = [
  { identity: join.participantIdentity, name: 'Ada', isLocal: true, microphoneEnabled: false, isSharing: false },
  { identity: 'participant-2', name: 'Ben', isLocal: false, microphoneEnabled: true, isSharing: false },
  { identity: 'participant-3', name: 'Chen', isLocal: false, microphoneEnabled: false, isSharing: false },
  { identity: 'participant-4', name: 'Dee', isLocal: false, microphoneEnabled: true, isSharing: false },
  { identity: 'participant-5', name: 'Eli', isLocal: false, microphoneEnabled: false, isSharing: false }
];

class FakeMeetingRoomController implements MeetingRoomController {
  state: MeetingRoomState = {
    connection: 'connected',
    participants,
    microphoneEnabled: false,
    audioPlaybackBlocked: false,
    screenShareAuthorized: false
  };
  readonly microphoneChanges: Array<{ enabled: boolean; deviceId?: string }> = [];
  readonly outputChanges: string[] = [];
  readonly callVolumes: number[] = [];
  disconnectCount = 0;
  private listeners = new Set<(state: MeetingRoomState) => void>();

  async connect() {}
  async setMicrophoneEnabled(enabled: boolean, deviceId?: string) {
    this.microphoneChanges.push({ enabled, deviceId });
    this.state = {
      ...this.state,
      microphoneEnabled: enabled,
      participants: this.state.participants.map((participant) => participant.isLocal ? { ...participant, microphoneEnabled: enabled } : participant)
    };
    this.emit();
  }
  async switchAudioOutput(deviceId: string) { this.outputChanges.push(deviceId); return 'changed' as const; }
  setCallAudioVolume(volume: number) { this.callVolumes.push(volume); }
  async publishScreenShare() {}
  async releaseScreenShare() {}
  async setRemoteScreenShareSubscribed() {}
  async disconnect() { this.disconnectCount += 1; }
  async resumeAudioPlayback() { this.state = { ...this.state, audioPlaybackBlocked: false }; this.emit(); }
  subscribe(listener: (state: MeetingRoomState) => void) { this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener); }
  blockAudio() { this.state = { ...this.state, audioPlaybackBlocked: true }; this.emit(); }
  private emit() { for (const listener of this.listeners) listener(this.state); }
}

const devices: MediaDeviceInfo[] = [
  { deviceId: 'microphone-1', groupId: 'input', kind: 'audioinput', label: 'Built-in microphone', toJSON: () => ({}) },
  { deviceId: 'microphone-2', groupId: 'input', kind: 'audioinput', label: 'USB microphone', toJSON: () => ({}) },
  { deviceId: 'speaker-1', groupId: 'output', kind: 'audiooutput', label: 'Built-in speakers', toJSON: () => ({}) },
  { deviceId: 'speaker-2', groupId: 'output', kind: 'audiooutput', label: 'Headset', toJSON: () => ({}) }
];

function renderRoom(controller = new FakeMeetingRoomController(), leaveMeeting = vi.fn().mockResolvedValue(undefined)) {
  render(<MeetingRoomPage slug="meeting-slug" join={join} controller={controller} leaveMeeting={leaveMeeting} listDevices={async () => devices} />);
  return { controller, leaveMeeting };
}

describe('meeting room UI', () => {
  it('opens the participant drawer and returns focus when Escape closes it', async () => {
    renderRoom();
    const trigger = await screen.findByRole('button', { name: 'Participants' });

    await userEvent.click(trigger);
    const drawer = screen.getByRole('dialog', { name: 'Participants' });
    expect(drawer).toBeVisible();
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(document.querySelector('.meeting-workspace')).toHaveAttribute('inert');
    expect(within(drawer).getByRole('button', { name: 'Close panel' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Participants' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps focus inside a drawer when live meeting state rerenders the page', async () => {
    const { controller } = renderRoom();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const slider = screen.getByRole('slider', { name: 'Call audio volume' });
    slider.focus();

    await act(() => controller.setMicrophoneEnabled(true));

    expect(slider).toHaveFocus();
  });

  it('keeps primary actions in a toolbar and opens low-frequency controls from More', async () => {
    renderRoom();
    const toolbar = await screen.findByRole('toolbar', { name: 'Primary meeting controls' });

    expect(within(toolbar).getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
    expect(within(toolbar).getByRole('button', { name: 'Share screen' })).toBeVisible();
    expect(within(toolbar).getByRole('button', { name: 'More' })).toBeVisible();
    expect(screen.queryByLabelText('Screen-share codec')).not.toBeInTheDocument();

    await userEvent.click(within(toolbar).getByRole('button', { name: 'More' }));
    expect(screen.getByRole('dialog', { name: 'More' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Screen sharing settings' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Screen sharing settings' }));
    expect(screen.getByRole('dialog', { name: 'Audio and sharing settings' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Back to More' }));
    expect(screen.getByRole('dialog', { name: 'More' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'WebRTC data' }));
    expect(screen.getByRole('dialog', { name: 'WebRTC data' })).toBeVisible();
    expect(screen.getByText('No active screen-share data.')).toBeVisible();
  });

  it('uses a compact top bar and a dedicated stage shell', async () => {
    renderRoom();

    expect(await screen.findByRole('banner')).toHaveClass('meeting-topbar');
    expect(document.querySelector('.meeting-stage-shell')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Participants' }));
    expect(document.querySelector('.meeting-management')).toBeInTheDocument();
  });

  it('creates its default controller only once across page rerenders', async () => {
    const controller = new FakeMeetingRoomController();
    const controllerFactory = vi.fn(() => controller);
    render(<MeetingRoomPage
      slug="meeting-slug"
      join={join}
      controllerFactory={controllerFactory}
      leaveMeeting={vi.fn().mockResolvedValue(undefined)}
      listDevices={async () => devices}
    />);

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('option', { name: 'USB microphone' });

    expect(controllerFactory).toHaveBeenCalledOnce();
  });

  it('shows five participants with independent microphone states', async () => {
    renderRoom();

    expect(screen.getByRole('main')).not.toHaveClass('meeting-room-sharing');
    await userEvent.click(screen.getByRole('button', { name: 'Participants' }));
    const roster = await screen.findByRole('list', { name: 'Participants' });
    expect(within(roster).getAllByRole('listitem')).toHaveLength(5);
    expect(within(roster).getByRole('listitem', { name: 'Ada, you, microphone muted' })).toBeVisible();
    expect(within(roster).getByRole('listitem', { name: 'Ben, microphone on' })).toBeVisible();
    expect(within(roster).getByRole('listitem', { name: 'Chen, microphone muted' })).toBeVisible();
  });

  it('lets an ordinary member freely unmute their own microphone', async () => {
    renderRoom();

    await userEvent.click(await screen.findByRole('button', { name: 'Unmute microphone' }));

    expect(await screen.findByRole('button', { name: 'Mute microphone' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Participants' }));
    expect(screen.getByRole('listitem', { name: 'Ada, you, microphone on' })).toBeVisible();
  });

  it('switches microphone and speaker devices without changing the microphone state', async () => {
    const { controller } = renderRoom();

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await userEvent.selectOptions(await screen.findByLabelText('Microphone device'), 'microphone-2');
    await userEvent.selectOptions(screen.getByLabelText('Speaker device'), 'speaker-2');

    expect(controller.microphoneChanges).toContainEqual({ enabled: false, deviceId: 'microphone-2' });
    expect(controller.outputChanges).toEqual(['speaker-2']);
  });

  it('routes the call-audio slider to the aggregate remote microphone volume', async () => {
    const { controller } = renderRoom();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const slider = await screen.findByRole('slider', { name: 'Call audio volume' });

    fireEvent.change(slider, { target: { value: '35' } });

    expect(controller.callVolumes).toEqual([0.35]);
  });

  it('routes the remote shared-audio slider into the active stage element volume', async () => {
    window.localStorage.setItem('babagan.viewer-transport', 'sfu');
    const attach = (element?: HTMLMediaElement) => element ?? document.createElement('video');
    const detach = (element?: HTMLMediaElement) => element ?? [];
    const controller = new FakeMeetingRoomController();
    controller.state = {
      ...controller.state,
      remoteScreenShare: {
        track: { kind: 'video', attach, detach },
        audioTrack: { kind: 'audio', attach, detach },
        sharerIdentity: 'participant-2',
        sharerName: 'Ben'
      }
    };
    renderRoom(controller);

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const slider = await screen.findByRole('slider', { name: 'Shared audio volume' });
    fireEvent.change(slider, { target: { value: '40' } });

    const video = screen.getByLabelText("Ben's shared screen") as HTMLVideoElement;
    await waitFor(() => expect(video.volume).toBe(0.4));
  });

  it('notifies the leave API before disconnecting gracefully', async () => {
    const order: string[] = [];
    const controller = new FakeMeetingRoomController();
    controller.disconnect = vi.fn(async () => { order.push('disconnect'); });
    const leaveMeeting = vi.fn(async () => { order.push('leave-api'); });
    renderRoom(controller, leaveMeeting);

    await userEvent.click(await screen.findByRole('button', { name: 'Leave meeting' }));

    await waitFor(() => expect(order).toEqual(['leave-api', 'disconnect']));
  });

  it('posts the scoped leave endpoint with participant credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MeetingRoomPage
      slug="meeting slug"
      join={join}
      controller={new FakeMeetingRoomController()}
      listDevices={async () => devices}
    />);

    await userEvent.click(await screen.findByRole('button', { name: 'Leave meeting' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/meetings/meeting%20slug/leave', {
      method: 'POST', credentials: 'include'
    }));
  });

  it('offers a user-gesture recovery only while remote audio is autoplay-blocked', async () => {
    const { controller } = renderRoom();
    expect(screen.queryByRole('button', { name: '点击恢复声音' })).not.toBeInTheDocument();

    controller.blockAudio();
    const resumeAudio = await screen.findByRole('button', { name: 'Click to resume audio' });
    expect(resumeAudio).toBeVisible();
    await userEvent.click(resumeAudio);

    expect(screen.queryByRole('button', { name: 'Click to resume audio' })).not.toBeInTheDocument();
  });
});

describe('remote audio playback', () => {
  it('clamps call volume to the safe media-element range', async () => {
    const element = {
      play: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(),
      volume: 1
    } as unknown as HTMLMediaElement;
    const playback = new AudioPlayback();
    await playback.add(element);

    playback.setVolume(1.5);
    expect(element.volume).toBe(1);

    playback.setVolume(-0.5);
    expect(element.volume).toBe(0);
  });

  it('applies the selected call volume to current and future remote audio', async () => {
    const current = {
      play: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(),
      volume: 1
    } as unknown as HTMLMediaElement;
    const future = {
      play: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(),
      volume: 1
    } as unknown as HTMLMediaElement;
    const playback = new AudioPlayback();

    await playback.add(current);
    (playback as AudioPlayback & { setVolume?: (volume: number) => void }).setVolume?.(0.35);
    await playback.add(future);

    expect(current.volume).toBe(0.35);
    expect(future.volume).toBe(0.35);
  });

  it('reports a rejected media play attempt and recovers from a later user gesture', async () => {
    const play = vi.fn()
      .mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined);
    const element = { play, remove: vi.fn() } as unknown as HTMLMediaElement;
    const playback = new AudioPlayback();
    const statuses: boolean[] = [];
    playback.subscribe((blocked) => statuses.push(blocked));

    await playback.add(element);
    expect(statuses.at(-1)).toBe(true);

    await playback.resume();
    expect(statuses.at(-1)).toBe(false);
  });

  it('recognizes a browser autoplay rejection from another JavaScript realm', async () => {
    const rejection = Object.assign(new Error('Blocked'), { name: 'NotAllowedError' });
    const element = { play: vi.fn().mockRejectedValue(rejection), remove: vi.fn() } as unknown as HTMLMediaElement;
    const playback = new AudioPlayback();
    const statuses: boolean[] = [];
    playback.subscribe((blocked) => statuses.push(blocked));

    await playback.add(element);

    expect(statuses.at(-1)).toBe(true);
  });

  it('stays blocked until every blocked remote element is released or recovers', async () => {
    const blocked = {
      play: vi.fn().mockRejectedValue(new DOMException('Blocked', 'NotAllowedError')),
      remove: vi.fn()
    } as unknown as HTMLMediaElement;
    const playing = {
      play: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn()
    } as unknown as HTMLMediaElement;
    const playback = new AudioPlayback();
    const statuses: boolean[] = [];
    playback.subscribe((status) => statuses.push(status));

    await playback.add(blocked);
    await playback.add(playing);
    expect(statuses.at(-1)).toBe(true);

    playback.remove(blocked);
    expect(statuses.at(-1)).toBe(false);
  });

  it('ignores a late autoplay rejection after playback ownership is cleared', async () => {
    let rejectPlay!: (reason: unknown) => void;
    const element = {
      play: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject; })),
      remove: vi.fn()
    } as unknown as HTMLMediaElement;
    const playback = new AudioPlayback();
    const statuses: boolean[] = [];
    playback.subscribe((status) => statuses.push(status));
    const pendingAdd = playback.add(element);

    playback.clear();
    rejectPlay(new DOMException('Blocked late', 'NotAllowedError'));
    await pendingAdd;

    expect(statuses.at(-1)).toBe(false);
  });

  it('ignores an old rejection after the same element is removed and re-added', async () => {
    let rejectFirstPlay!: (reason: unknown) => void;
    const element = {
      play: vi.fn()
        .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirstPlay = reject; }))
        .mockResolvedValueOnce(undefined),
      remove: vi.fn()
    } as unknown as HTMLMediaElement;
    const playback = new AudioPlayback();
    const statuses: boolean[] = [];
    playback.subscribe((status) => statuses.push(status));
    const oldLifetime = playback.add(element);

    playback.remove(element);
    await playback.add(element);
    rejectFirstPlay(new DOMException('Old playback blocked', 'NotAllowedError'));
    await oldLifetime;

    expect(statuses.at(-1)).toBe(false);
  });
});
