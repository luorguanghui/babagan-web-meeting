import type { JoinMeetingResponse } from '@meeting/contracts';
import { useEffect, useState } from 'react';

import { MeetingControls } from '../components/meeting-controls.js';
import { ParticipantList } from '../components/participant-list.js';
import { createRoomController, type MeetingRoomController } from '../meeting/room-controller.js';
import { useMeetingRoom } from '../meeting/use-meeting-room.js';

export interface MeetingRoomPageProps {
  slug: string;
  join: JoinMeetingResponse;
  controller?: MeetingRoomController;
  controllerFactory?: () => MeetingRoomController;
  leaveMeeting?: (slug: string) => Promise<void>;
  listDevices?: () => Promise<MediaDeviceInfo[]>;
  onLeft?: () => void;
}

async function defaultLeaveMeeting(slug: string): Promise<void> {
  const response = await fetch(`/api/v1/meetings/${encodeURIComponent(slug)}/leave`, { method: 'POST', credentials: 'include' });
  if (!response.ok) throw new Error('The meeting could not be left cleanly.');
}

async function defaultListDevices(): Promise<MediaDeviceInfo[]> {
  return navigator.mediaDevices?.enumerateDevices ? navigator.mediaDevices.enumerateDevices() : [];
}

export function MeetingRoomPage({
  slug,
  join,
  controller: providedController,
  controllerFactory = createRoomController,
  leaveMeeting = defaultLeaveMeeting,
  listDevices = defaultListDevices,
  onLeft
}: MeetingRoomPageProps) {
  const [controller] = useState(() => providedController ?? controllerFactory());
  const { state, error: connectionError } = useMeetingRoom(join, controller);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [notice, setNotice] = useState<string>();
  const [leaving, setLeaving] = useState(false);

  useEffect(() => { void listDevices().then(setDevices).catch(() => setNotice('Audio devices could not be listed.')); }, [listDevices]);

  async function leave() {
    setLeaving(true);
    try {
      await leaveMeeting(slug);
    } catch {
      setNotice('The server could not confirm that you left.');
    } finally {
      await controller.disconnect();
      setLeaving(false);
      onLeft?.();
    }
  }

  async function changeSpeaker(deviceId: string) {
    const result = await controller.switchAudioOutput(deviceId);
    setNotice(result === 'unsupported' ? 'This browser does not support speaker switching.' : undefined);
  }

  return <main className="meeting-room">
    <header><p className="eyebrow">Meeting room</p><h1>{join.participantName}, you are in</h1></header>
    {(connectionError || notice) && <p role={connectionError ? 'alert' : 'status'}>{connectionError ?? notice}</p>}
    <ParticipantList participants={state.participants} />
    <MeetingControls
      connection={state.connection}
      microphoneEnabled={state.microphoneEnabled}
      audioPlaybackBlocked={state.audioPlaybackBlocked}
      devices={devices}
      leaving={leaving}
      onMicrophoneToggle={() => void controller.setMicrophoneEnabled(!state.microphoneEnabled)}
      onMicrophoneDeviceChange={(deviceId) => void controller.setMicrophoneEnabled(state.microphoneEnabled, deviceId)}
      onSpeakerDeviceChange={(deviceId) => void changeSpeaker(deviceId)}
      onResumeAudio={() => void controller.resumeAudioPlayback()}
      onLeave={() => void leave()}
    />
  </main>;
}
