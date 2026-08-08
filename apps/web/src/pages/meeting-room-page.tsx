import {
  RefreshParticipantTokenResponseSchema,
  type JoinMeetingResponse,
  type ParticipantSummary,
  type RefreshParticipantTokenResponse
} from '@meeting/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiRequest } from '../api/client.js';
import { HostMenu } from '../components/host-menu.js';
import { MeetingControls } from '../components/meeting-controls.js';
import { ParticipantList } from '../components/participant-list.js';
import { ScreenStage } from '../components/screen-stage.js';
import { createRoomController, type MeetingRoomController } from '../meeting/room-controller.js';
import {
  createScreenShareController,
  type CaptureProfile,
  type ScreenShareState
} from '../meeting/screen-share.js';
import { useMeetingRoom } from '../meeting/use-meeting-room.js';

export interface MeetingRoomPageProps {
  slug: string;
  join: JoinMeetingResponse;
  controller?: MeetingRoomController;
  controllerFactory?: () => MeetingRoomController;
  leaveMeeting?: (slug: string) => Promise<void>;
  listDevices?: () => Promise<MediaDeviceInfo[]>;
  meetingApi?: MeetingRoomApi;
  getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
  onLeft?: () => void;
}

export interface MeetingRoomApi {
  authorizeHost(slug: string): Promise<void>;
  verifyParticipantShare(slug: string): Promise<void>;
  grantShare(slug: string, identity: string): Promise<void>;
  releaseOwnShare(slug: string): Promise<void>;
  revokeShare(slug: string): Promise<void>;
  kick(slug: string, identity: string): Promise<void>;
  end(slug: string): Promise<void>;
}

async function defaultLeaveMeeting(slug: string): Promise<void> {
  const response = await fetch(`/api/v1/meetings/${encodeURIComponent(slug)}/leave`, { method: 'POST', credentials: 'include' });
  if (!response.ok) throw new Error('The meeting could not be left cleanly.');
}

async function defaultListDevices(): Promise<MediaDeviceInfo[]> {
  return navigator.mediaDevices?.enumerateDevices ? navigator.mediaDevices.enumerateDevices() : [];
}

const defaultMeetingApi: MeetingRoomApi = {
  authorizeHost: (slug) => noContent(`/meetings/${encodeURIComponent(slug)}/host-session`, 'GET'),
  async verifyParticipantShare(slug) {
    const response = await apiRequest<RefreshParticipantTokenResponse>(
      `/meetings/${encodeURIComponent(slug)}/token`,
      RefreshParticipantTokenResponseSchema,
      { method: 'POST' }
    );
    if (!response.permissions.canShareScreen) throw new Error('Screen sharing is not authorized.');
  },
  grantShare: (slug, identity) => noContent(
    `/meetings/${encodeURIComponent(slug)}/share-grant`,
    'PUT',
    { participantIdentity: identity }
  ),
  releaseOwnShare: (slug) => noContent(`/meetings/${encodeURIComponent(slug)}/share`, 'DELETE'),
  revokeShare: (slug) => noContent(`/meetings/${encodeURIComponent(slug)}/share-grant`, 'DELETE'),
  kick: (slug, identity) => noContent(
    `/meetings/${encodeURIComponent(slug)}/kick`,
    'POST',
    { participantIdentity: identity }
  ),
  end: (slug) => noContent(`/meetings/${encodeURIComponent(slug)}/end`, 'POST')
};

async function noContent(path: string, method: string, body?: object): Promise<void> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'include',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error('The meeting action could not be completed.');
}

export function MeetingRoomPage({
  slug,
  join,
  controller: providedController,
  controllerFactory = createRoomController,
  leaveMeeting = defaultLeaveMeeting,
  listDevices = defaultListDevices,
  meetingApi = defaultMeetingApi,
  getDisplayMedia,
  onLeft
}: MeetingRoomPageProps) {
  const [controller] = useState(() => providedController ?? controllerFactory());
  const { state, error: connectionError } = useMeetingRoom(join, controller);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [notice, setNotice] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const [hostAuthorized, setHostAuthorized] = useState(false);
  const hostAuthorizedRef = useRef(false);
  const [screenProfile, setScreenProfile] = useState<CaptureProfile>('standard');
  const [screenState, setScreenState] = useState<ScreenShareState>({ status: 'idle', profile: 'standard' });
  const authorizeHost = useCallback(() => meetingApi.authorizeHost(slug), [meetingApi, slug]);
  const authorizationChanged = useCallback((authorized: boolean) => {
    hostAuthorizedRef.current = authorized;
    setHostAuthorized(authorized);
  }, []);
  const screenShare = useMemo(() => createScreenShareController({
    requestGrant: () => hostAuthorizedRef.current
      ? meetingApi.grantShare(slug, join.participantIdentity)
      : meetingApi.verifyParticipantShare(slug),
    releaseGrant: () => meetingApi.releaseOwnShare(slug),
    ...(getDisplayMedia ? { getDisplayMedia } : {}),
    publisher: {
      publish: (stream, options) => controller.publishScreenShare(stream, options),
      release: (stream) => controller.releaseScreenShare(stream)
    }
  }), [controller, getDisplayMedia, join.participantIdentity, meetingApi, slug]);

  useEffect(() => { void listDevices().then(setDevices).catch(() => setNotice('Audio devices could not be listed.')); }, [listDevices]);
  useEffect(() => {
    const unsubscribe = screenShare.subscribe(setScreenState);
    return () => {
      unsubscribe();
      void screenShare.stop();
    };
  }, [screenShare]);

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

  async function toggleScreenShare() {
    setNotice(undefined);
    try {
      if (screenState.status === 'sharing') await screenShare.stop();
      else await screenShare.start(screenProfile);
    } catch {
      setNotice('Screen sharing could not be started. Check that the host grant is still active.');
    }
  }

  const hostParticipants: ParticipantSummary[] = state.participants.map((participant) => ({
    identity: participant.identity,
    name: participant.name,
    isSharing: participant.isSharing
  }));
  const stageStream = screenState.stream ?? state.remoteScreenShare?.stream;
  const sharerName = screenState.stream
    ? join.participantName
    : state.remoteScreenShare?.sharerName;

  return <main className="meeting-room">
    <header><p className="eyebrow">Meeting room</p><h1>{join.participantName}, you are in</h1></header>
    {(connectionError || notice) && <p role={connectionError ? 'alert' : 'status'}>{connectionError ?? notice}</p>}
    {screenState.audioGuidance && <p role="status">{screenState.audioGuidance}</p>}
    <ScreenStage stream={stageStream} sharerName={sharerName} />
    <ParticipantList participants={state.participants} />
    <HostMenu
      participants={hostParticipants}
      authorizeHost={authorizeHost}
      onAuthorizationChange={authorizationChanged}
      onGrantShare={(identity) => meetingApi.grantShare(slug, identity)}
      onRevokeShare={() => meetingApi.revokeShare(slug)}
      onKick={(identity) => meetingApi.kick(slug, identity)}
      onEndMeeting={() => meetingApi.end(slug)}
    />
    <MeetingControls
      connection={state.connection}
      microphoneEnabled={state.microphoneEnabled}
      audioPlaybackBlocked={state.audioPlaybackBlocked}
      devices={devices}
      leaving={leaving}
      screenShareAuthorized={hostAuthorized || Boolean(state.screenShareAuthorized)}
      screenShareActive={screenState.status === 'sharing'}
      screenShareBusy={screenState.status === 'starting'}
      screenProfile={screenProfile}
      onMicrophoneToggle={() => void controller.setMicrophoneEnabled(!state.microphoneEnabled)}
      onMicrophoneDeviceChange={(deviceId) => void controller.setMicrophoneEnabled(state.microphoneEnabled, deviceId)}
      onSpeakerDeviceChange={(deviceId) => void changeSpeaker(deviceId)}
      onResumeAudio={() => void controller.resumeAudioPlayback()}
      onScreenProfileChange={setScreenProfile}
      onScreenShareToggle={() => void toggleScreenShare()}
      onLeave={() => void leave()}
    />
  </main>;
}
