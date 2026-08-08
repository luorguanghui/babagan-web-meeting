import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

describe('room controller', () => {
  it('connects with subscription optimizations while keeping the local microphone muted', async () => {
    const room = roomAdapter();
    const createRoom = vi.fn(() => room);
    const controller = createRoomController(createRoom);

    await controller.connect(join);

    expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: expect.objectContaining({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      })
    }));
    expect(room.connect).toHaveBeenCalledWith(join.livekitUrl, join.token, expect.objectContaining({ autoSubscribe: true }));
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
    const disconnected = vi.mocked(room.on).mock.calls.find(([event]) => event === 'disconnected')?.[1];

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

  it('fully releases the SDK room after an unexpected disconnect event', async () => {
    const room = roomAdapter();
    const controller = createRoomController(() => room);
    await controller.connect(join);
    const disconnected = vi.mocked(room.on).mock.calls.find(([event]) => event === 'disconnected')?.[1];

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
    const subscribed = vi.mocked(room.on).mock.calls.find(([event]) => event === 'trackSubscribed')?.[1];

    subscribed?.({ kind: 'audio', attach: () => element, detach: () => element });

    await waitFor(() => expect(states.at(-1)?.audioPlaybackBlocked).toBe(true));
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
    audioPlaybackBlocked: false
  };
  readonly microphoneChanges: Array<{ enabled: boolean; deviceId?: string }> = [];
  readonly outputChanges: string[] = [];
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

    await screen.findByRole('option', { name: 'USB microphone' });

    expect(controllerFactory).toHaveBeenCalledOnce();
  });

  it('shows five participants with independent microphone states', async () => {
    renderRoom();

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
    expect(screen.getByRole('listitem', { name: 'Ada, you, microphone on' })).toBeVisible();
  });

  it('switches microphone and speaker devices without changing the microphone state', async () => {
    const { controller } = renderRoom();

    await userEvent.selectOptions(await screen.findByLabelText('Microphone device'), 'microphone-2');
    await userEvent.selectOptions(screen.getByLabelText('Speaker device'), 'speaker-2');

    expect(controller.microphoneChanges).toContainEqual({ enabled: false, deviceId: 'microphone-2' });
    expect(controller.outputChanges).toEqual(['speaker-2']);
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
    await userEvent.click(await screen.findByRole('button', { name: '点击恢复声音' }));

    expect(screen.queryByRole('button', { name: '点击恢复声音' })).not.toBeInTheDocument();
  });
});

describe('remote audio playback', () => {
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
