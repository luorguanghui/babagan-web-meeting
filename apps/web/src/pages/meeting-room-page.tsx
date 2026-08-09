import {
  RefreshParticipantTokenResponseSchema,
  type JoinMeetingResponse,
  type ParticipantSummary,
  type RefreshParticipantTokenResponse,
  type ScreenShareCodec
} from '@meeting/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiNoContent, apiRequest } from '../api/client.js';
import { AdminEndMeetingForm } from '../components/admin-end-meeting-form.js';
import { HostMenu } from '../components/host-menu.js';
import { ConnectionBanner } from '../components/connection-banner.js';
import { MeetingControls } from '../components/meeting-controls.js';
import { ParticipantList } from '../components/participant-list.js';
import { ScreenStage } from '../components/screen-stage.js';
import { WebRtcStatsPanel } from '../components/webrtc-stats-panel.js';
import { type MessageKey, type Translate, useI18n } from '../i18n/i18n.js';
import { createRoomController, type MeetingRoomController } from '../meeting/room-controller.js';
import {
  createScreenShareController,
  type CaptureProfile,
  type MotionBitrate,
  type ScreenShareState,
  type UnrestrictedSystemAudioChoice
} from '../meeting/screen-share.js';
import { useMeetingRoom } from '../meeting/use-meeting-room.js';
import { summarizeWebRtcStats, type WebRtcStatsSnapshot } from '../meeting/webrtc-stats.js';

export interface MeetingRoomPageProps {
  slug: string;
  join: JoinMeetingResponse;
  controller?: MeetingRoomController;
  controllerFactory?: () => MeetingRoomController;
  leaveMeeting?: (slug: string) => Promise<void>;
  listDevices?: () => Promise<MediaDeviceInfo[]>;
  meetingApi?: MeetingRoomApi;
  getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
  supportsOwnAudioRestriction?: () => boolean;
  onLeft?: () => void;
  onTerminal?: (reason: 'ended' | 'expired' | 'rejoin-required') => void;
}

export interface MeetingRoomApi {
  authorizeHost(slug: string): Promise<void>;
  verifyParticipantShare(slug: string): Promise<void>;
  grantShare(slug: string, identity: string): Promise<void>;
  releaseOwnShare(slug: string): Promise<void>;
  revokeShare(slug: string): Promise<void>;
  kick(slug: string, identity: string): Promise<void>;
  end(slug: string): Promise<void>;
  adminEnd?(slug: string, adminPassword: string): Promise<void>;
}

type HostAuthorizationState = 'unknown' | 'authorized' | 'unauthorized';

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
  end: (slug) => noContent(`/meetings/${encodeURIComponent(slug)}/end`, 'POST'),
  adminEnd: (slug, adminPassword) => apiNoContent(
    `/meetings/${encodeURIComponent(slug)}/admin-end`,
    { method: 'POST', body: JSON.stringify({ adminPassword }) }
  )
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
  supportsOwnAudioRestriction,
  onLeft,
  onTerminal
}: MeetingRoomPageProps) {
  const { t } = useI18n();
  const [controller] = useState(() => providedController ?? controllerFactory());
  const refresh = useCallback(() => apiRequest<RefreshParticipantTokenResponse>(
    `/meetings/${encodeURIComponent(slug)}/token`,
    RefreshParticipantTokenResponseSchema,
    { method: 'POST' }
  ), [slug]);
  const { state, error: connectionError, reconnectState, reconnectRateLimited } = useMeetingRoom(join, controller, refresh);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [notice, setNotice] = useState<string>();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [leaving, setLeaving] = useState(false);
  const [hostAuthorized, setHostAuthorized] = useState(false);
  const [hostAuthorization, setHostAuthorization] = useState<HostAuthorizationState>('unknown');
  const hostAuthorizedRef = useRef(false);
  const [screenProfile, setScreenProfile] = useState<CaptureProfile>('standard');
  const [screenCodec, setScreenCodec] = useState<ScreenShareCodec>('h264');
  const [screenBitrate, setScreenBitrate] = useState<MotionBitrate>(10_000_000);
  const [screenState, setScreenState] = useState<ScreenShareState>({ status: 'idle', profile: 'standard' });
  const [screenStats, setScreenStats] = useState<WebRtcStatsSnapshot>();
  const [systemAudioDecision, setSystemAudioDecision] = useState<{ displaySurface: string }>();
  const systemAudioDecisionResolver = useRef<((choice: UnrestrictedSystemAudioChoice) => void) | undefined>(undefined);
  const authorizeHost = useCallback(() => meetingApi.authorizeHost(slug), [meetingApi, slug]);
  const authorizationChanged = useCallback((authorized: boolean) => {
    hostAuthorizedRef.current = authorized;
    setHostAuthorized(authorized);
    setHostAuthorization(authorized ? 'authorized' : 'unauthorized');
  }, []);
  const chooseUnrestrictedSystemAudio = useCallback((context: { displaySurface: string }) => new Promise<UnrestrictedSystemAudioChoice>((resolve) => {
    systemAudioDecisionResolver.current = resolve;
    setSystemAudioDecision(context);
  }), []);
  const resolveSystemAudioDecision = useCallback((choice: UnrestrictedSystemAudioChoice) => {
    const resolve = systemAudioDecisionResolver.current;
    systemAudioDecisionResolver.current = undefined;
    setSystemAudioDecision(undefined);
    resolve?.(choice);
  }, []);
  const screenShare = useMemo(() => createScreenShareController({
    requestGrant: () => hostAuthorizedRef.current
      ? meetingApi.grantShare(slug, join.participantIdentity)
      : meetingApi.verifyParticipantShare(slug),
    releaseGrant: () => meetingApi.releaseOwnShare(slug),
    ...(getDisplayMedia ? { getDisplayMedia } : {}),
    ...(supportsOwnAudioRestriction ? { supportsOwnAudioRestriction } : {}),
    chooseUnrestrictedSystemAudio,
    publisher: {
      publish: (stream, options) => controller.publishScreenShare(stream, options),
      release: (stream) => controller.releaseScreenShare(stream)
    }
  }), [chooseUnrestrictedSystemAudio, controller, getDisplayMedia, join.participantIdentity, meetingApi, slug, supportsOwnAudioRestriction]);

  useEffect(() => { void listDevices().then(setDevices).catch(() => setNotice(t('room.devicesFailed'))); }, [listDevices, t]);
  useEffect(() => {
    const unsubscribe = screenShare.subscribe(setScreenState);
    return () => {
      unsubscribe();
      void screenShare.stop();
    };
  }, [screenShare]);
  useEffect(() => () => {
    systemAudioDecisionResolver.current?.('cancel');
    systemAudioDecisionResolver.current = undefined;
  }, []);
  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener('online', connected);
    window.addEventListener('offline', disconnected);
    return () => {
      window.removeEventListener('online', connected);
      window.removeEventListener('offline', disconnected);
    };
  }, []);
  useEffect(() => {
    if (reconnectState.kind === 'terminal') onTerminal?.(reconnectState.reason);
    if (reconnectState.kind === 'rejoin-required') onTerminal?.('rejoin-required');
  }, [onTerminal, reconnectState]);

  async function leave() {
    setLeaving(true);
    try {
      await leaveMeeting(slug);
    } catch {
      setNotice(t('room.leaveUnconfirmed'));
    } finally {
      await controller.disconnect();
      setLeaving(false);
      onLeft?.();
    }
  }

  async function changeSpeaker(deviceId: string) {
    const result = await controller.switchAudioOutput(deviceId);
    setNotice(result === 'unsupported' ? t('room.speakerUnsupported') : undefined);
  }

  async function toggleScreenShare() {
    setNotice(undefined);
    try {
      if (screenState.status === 'sharing') await screenShare.stop();
      else await screenShare.start(screenProfile, screenCodec, screenBitrate);
    } catch {
      setNotice(t('room.shareFailed'));
    }
  }

  const hostParticipants: ParticipantSummary[] = state.participants.map((participant) => ({
    identity: participant.identity,
    name: participant.name,
    isSharing: participant.isSharing
  }));
  const stageStream = screenState.stream;
  const stageTrack = screenState.stream ? undefined : state.remoteScreenShare?.track;
  const stageAudioTrack = screenState.stream ? undefined : state.remoteScreenShare?.audioTrack;
  const hasActiveScreenShare = Boolean(stageStream || stageTrack);
  const sharerName = screenState.stream
    ? join.participantName
    : state.remoteScreenShare?.sharerName;

  useEffect(() => {
    if (!hasActiveScreenShare || !controller.getScreenShareStatsReports) {
      setScreenStats(undefined);
      return;
    }
    let cancelled = false;
    let previous: WebRtcStatsSnapshot | undefined;
    const sample = async () => {
      try {
        const reports = await controller.getScreenShareStatsReports!();
        if (cancelled) return;
        previous = summarizeWebRtcStats(reports, previous);
        setScreenStats(previous);
      } catch {
        // Statistics are diagnostic only and must never interrupt the meeting.
      }
    };
    void sample();
    const timer = window.setInterval(() => void sample(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [controller, hasActiveScreenShare]);

  return <main className={`meeting-room${hasActiveScreenShare ? ' meeting-room-sharing' : ''}`}>
    <header className="meeting-room-header">
      <div className="meeting-room-title">
        <p className="eyebrow">{t('room.eyebrow')}</p>
        <h1>{t('room.heading', { name: join.participantName })}</h1>
      </div>
      <ConnectionBanner state={reconnectState} online={online} rateLimited={reconnectRateLimited} />
    </header>
    <section className="meeting-notices" aria-live="polite">
      {(connectionError || notice) && <p role={connectionError ? 'alert' : 'status'}>{connectionError ?? notice}</p>}
      {screenState.audioGuidance && <p role="status">{localizedScreenGuidance(screenState.audioGuidance, t)}</p>}
      {systemAudioDecision && <section
        className="system-audio-warning"
        role="dialog"
        aria-modal="true"
        aria-labelledby="system-audio-warning-title"
      >
        <h2 id="system-audio-warning-title">{t('audioWarning.heading')}</h2>
        <p>{t('audioWarning.description', { surface: systemAudioDecision.displaySurface })}</p>
        <button type="button" onClick={() => resolveSystemAudioDecision('video-only')}>{t('audioWarning.videoOnly')}</button>
        <button type="button" onClick={() => resolveSystemAudioDecision('share-audio')}>{t('audioWarning.continue')}</button>
        <button type="button" onClick={() => resolveSystemAudioDecision('cancel')}>{t('audioWarning.cancel')}</button>
      </section>}
    </section>
    <div className="meeting-workspace">
      <div className="meeting-stage-column">
        <ScreenStage
          stream={stageStream}
          track={stageTrack}
          audioTrack={stageAudioTrack}
          sharerName={sharerName}
        >
          {hasActiveScreenShare && <WebRtcStatsPanel snapshot={screenStats} requestedCodec={screenCodec} />}
        </ScreenStage>
        <MeetingControls
          className="meeting-control-dock"
          connection={state.connection}
          microphoneEnabled={state.microphoneEnabled}
          audioPlaybackBlocked={state.audioPlaybackBlocked}
          devices={devices}
          leaving={leaving}
          screenShareAuthorized={hostAuthorized || Boolean(state.screenShareAuthorized)}
          screenShareActive={screenState.status === 'sharing'}
          screenShareBusy={screenState.status === 'starting'}
          screenProfile={screenProfile}
          screenCodec={screenCodec}
          screenBitrate={screenBitrate}
          onMicrophoneToggle={() => void controller.setMicrophoneEnabled(!state.microphoneEnabled)}
          onMicrophoneDeviceChange={(deviceId) => void controller.setMicrophoneEnabled(state.microphoneEnabled, deviceId)}
          onSpeakerDeviceChange={(deviceId) => void changeSpeaker(deviceId)}
          onResumeAudio={() => void controller.resumeAudioPlayback()}
          onScreenProfileChange={setScreenProfile}
          onScreenCodecChange={setScreenCodec}
          onScreenBitrateChange={setScreenBitrate}
          onScreenShareToggle={() => void toggleScreenShare()}
          onLeave={() => void leave()}
        />
      </div>
      <aside className="meeting-side-rail" aria-label={t('room.sidePanel')}>
        <ParticipantList participants={state.participants} />
        <HostMenu
          participants={hostParticipants}
          authorizeHost={authorizeHost}
          onAuthorizationChange={authorizationChanged}
          onGrantShare={(identity) => meetingApi.grantShare(slug, identity)}
          onRevokeShare={() => meetingApi.revokeShare(slug)}
          onKick={(identity) => meetingApi.kick(slug, identity)}
          onEndMeeting={() => meetingApi.end(slug)}
          onEnded={() => onTerminal?.('ended')}
        />
        {hostAuthorization === 'unauthorized' && meetingApi.adminEnd && <section className="participant-admin-end">
          <h2>{t('adminEnd.heading')}</h2>
          <AdminEndMeetingForm
            compact
            onEnd={(password) => meetingApi.adminEnd!(slug, password)}
            onEnded={() => onTerminal?.('ended')}
          />
        </section>}
      </aside>
    </div>
  </main>;
}

function localizedScreenGuidance(message: string, t: Translate): string {
  const key: MessageKey = message.startsWith('No computer audio')
    ? 'screen.noAudio'
    : message.startsWith('The screen is being shared without')
      ? 'screen.videoOnly'
      : message.startsWith('The browser could not isolate')
        ? 'screen.echoRisk'
        : message.startsWith('Screen sharing was cancelled')
          ? 'screen.chooseTab'
          : 'error.generic';
  return t(key);
}
