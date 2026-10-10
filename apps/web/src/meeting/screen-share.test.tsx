import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ComponentType } from 'react';

import { HostMenu } from '../components/host-menu.js';
import { MeetingControls, MeetingSettings } from '../components/meeting-controls.js';
import { ScreenStage } from '../components/screen-stage.js';
import { WebRtcStatsPanel } from '../components/webrtc-stats-panel.js';
import { LanguageProvider } from '../i18n/i18n.js';
import { ApiRequestError } from '../api/client.js';
import { MeetingRoomPage, type MeetingRoomApi, type MeetingRoomPageProps } from '../pages/meeting-room-page.js';
import {
  createP2pShareController,
  type P2pShareController,
  type P2pShareSignaling,
  type ViewerSessionState
} from './p2p-share-controller.js';
import type { Peer, P2pSignalingClient, P2pSignalingEvents } from './p2p-signaling.js';
import {
  createRoomController,
  type LiveKitRoomAdapter,
  type MeetingRoomController,
  type MeetingRoomState
} from './room-controller.js';
import {
  createScreenShareController,
  HybridScreenSharePublisher,
  recommendP2pBitrate
} from './screen-share.js';
import { createP2pStatsCollector, type P2pStatsCollector } from './p2p-stats.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  PageFakePc.instances = [];
  PageFakePc.remoteDescriptionGate = undefined;
  window.localStorage.removeItem('babagan.viewer-transport');
});

describe('controlled browser screen sharing', () => {
  it('does not offer a TURN provider selector when the server is the only provider', () => {
    render(<LanguageProvider><MeetingSettings connection="connected" microphoneEnabled={false} audioPlaybackBlocked={false} devices={[]} leaving={false}
      screenShareTurnProviderVisible onScreenShareTurnProviderChange={vi.fn()} onMicrophoneToggle={vi.fn()} onMicrophoneDeviceChange={vi.fn()} onSpeakerDeviceChange={vi.fn()} onResumeAudio={vi.fn()} onLeave={vi.fn()} /></LanguageProvider>);
    expect(screen.queryByRole('combobox', { name: 'Screen-share TURN provider' })).not.toBeInTheDocument();
  });
  it('holds a restart until the old publication and grant have both finished releasing', async () => {
    const first = displayStream({ audio: false }).stream;
    const second = displayStream({ audio: false }).stream;
    let finishPublication!: () => void;
    let finishGrant!: () => void;
    const release = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finishPublication = resolve; })).mockResolvedValue(undefined);
    const releaseGrant = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finishGrant = resolve; })).mockResolvedValue(undefined);
    const capture = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const grant = vi.fn(async () => undefined);
    const controller = createScreenShareController({ requestGrant: grant, releaseGrant, getDisplayMedia: capture, publisher: { publish: vi.fn(async () => undefined), release } });
    await controller.start();
    const stopped = controller.stop();
    const restarted = controller.start();
    await waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(capture).toHaveBeenCalledOnce();
    expect(grant).toHaveBeenCalledOnce();
    finishPublication();
    await Promise.resolve();
    expect(capture).toHaveBeenCalledOnce();
    finishGrant();
    await Promise.all([stopped, restarted]);
    expect(controller.getState()).toMatchObject({ status: 'sharing', stream: second });
    await controller.stop();
  });
  it('offers Cloudflare SFU at the source and locks software encoding for that choice', () => {
    render(<LanguageProvider><MeetingSettings connection="connected" microphoneEnabled={false} audioPlaybackBlocked={false} devices={[]} leaving={false}
      screenSourceTransport="cloudflare-sfu" onScreenSourceTransportChange={vi.fn()} onMicrophoneToggle={vi.fn()} onMicrophoneDeviceChange={vi.fn()} onSpeakerDeviceChange={vi.fn()} onResumeAudio={vi.fn()} onLeave={vi.fn()} /></LanguageProvider>);
    expect(screen.getByRole('option', { name: 'Cloudflare SFU (browser encoding)' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Detail (1080p60, resolution first)' })).toBeVisible();
    expect(screen.getByLabelText('Screen encoding engine')).toBeDisabled();
  });
  it('puts a subscribed remote screen track into room state without changing remote audio handling', async () => {
    const room = {
      connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
      on: vi.fn(), off: vi.fn(), remoteParticipants: new Map(),
      localParticipant: {
        identity: 'participant-1', name: 'Ada', isMicrophoneEnabled: false,
        isScreenShareEnabled: false
      },
      switchActiveDevice: vi.fn(async () => true)
    } as unknown as LiveKitRoomAdapter;
    const controller = createRoomController(() => room);
    const states: MeetingRoomState[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.connect({
      participantIdentity: 'participant-1', participantName: 'Ada',
      livekitUrl: 'wss://rtc.example.test', token: 'token', meetingExpiresAt: 10_000,
      permissions: { publishSources: ['microphone'] }
    });
    await controller.setRemoteScreenShareSubscribed(true);
    const { video } = displayStream({ audio: false });
    const remoteTrack = { kind: 'video', mediaStreamTrack: video, attach: vi.fn(), detach: vi.fn() };
    const subscribed = vi.mocked(room.on).mock.calls.find(([event]) => event === 'trackSubscribed')?.[1];

    subscribed?.(
      remoteTrack,
      { source: 'screen_share' },
      { identity: 'participant-2', name: 'Ben' }
    );

    expect(states.at(-1)).toMatchObject({
      remoteScreenShare: { track: remoteTrack, sharerIdentity: 'participant-2', sharerName: 'Ben' }
    });
    expect(document.querySelectorAll('audio')).toHaveLength(0);
  });

  it('routes screen-share audio into the matching screen stage instead of a separate audio element', async () => {
    const room = {
      connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
      on: vi.fn(), off: vi.fn(), remoteParticipants: new Map(),
      localParticipant: {
        identity: 'participant-1', name: 'Ada', isMicrophoneEnabled: false,
        isScreenShareEnabled: false
      },
      switchActiveDevice: vi.fn(async () => true)
    } as unknown as LiveKitRoomAdapter;
    const controller = createRoomController(() => room);
    const states: MeetingRoomState[] = [];
    controller.subscribe((state) => states.push(state));
    await controller.connect({
      participantIdentity: 'participant-1', participantName: 'Ada',
      livekitUrl: 'wss://rtc.example.test', token: 'token', meetingExpiresAt: 10_000,
      permissions: { publishSources: ['microphone'] }
    });
    await controller.setRemoteScreenShareSubscribed(true);
    const subscribed = vi.mocked(room.on).mock.calls.find(([event]) => event === 'trackSubscribed')?.[1];
    const videoTrack = {
      kind: 'video', attach: vi.fn(), detach: vi.fn(), setPlayoutDelay: vi.fn()
    };
    const audioTrack = {
      kind: 'audio',
      attach: vi.fn(() => document.createElement('audio')),
      detach: vi.fn(() => []),
      setPlayoutDelay: vi.fn()
    };

    subscribed?.(videoTrack, { source: 'screen_share' }, { identity: 'participant-2', name: 'Ben' });
    subscribed?.(audioTrack, { source: 'screen_share_audio' }, { identity: 'participant-2', name: 'Ben' });

    expect(states.at(-1)?.remoteScreenShare).toMatchObject({
      track: videoTrack,
      audioTrack,
      sharerIdentity: 'participant-2'
    });
    expect(document.querySelectorAll('audio')).toHaveLength(0);
    expect(videoTrack.setPlayoutDelay).toHaveBeenCalledWith(0.5);
    expect(audioTrack.setPlayoutDelay).toHaveBeenCalledWith(0.5);
  });

  it('renders a subscribed remote share in the room stage for a non-sharer', async () => {
    window.localStorage.setItem('babagan.viewer-transport', 'sfu');
    const { stream } = displayStream({ audio: false });
    const remoteTrack = {
      kind: 'video',
      attach: vi.fn((element?: HTMLMediaElement) => {
        const video = element ?? document.createElement('video');
        video.srcObject = stream;
        return video;
      }),
      detach: vi.fn((element?: HTMLMediaElement) => element ?? [])
    };
    const controller = meetingController({
      remoteScreenShare: {
        track: remoteTrack,
        sharerIdentity: 'participant-2',
        sharerName: 'Ben'
      } as unknown as MeetingRoomState['remoteScreenShare']
    });

    render(<MeetingRoomPage
      slug="meeting-slug"
      join={{
        participantIdentity: 'participant-1', participantName: 'Ada',
        livekitUrl: 'wss://rtc.example.test', token: 'token', meetingExpiresAt: 10_000,
        permissions: { publishSources: ['microphone'] }
      }}
      controller={controller}
      meetingApi={unauthorizedMeetingApi()}
      listDevices={async () => []}
    />);

    const video = await screen.findByLabelText("Ben's shared screen");
    expect(screen.getByRole('main')).toHaveClass('meeting-room-sharing');
    expect(remoteTrack.attach).toHaveBeenCalledWith(video);
    expect(video).toHaveProperty('srcObject', stream);
    expect(document.querySelector('.meeting-turn-probe-badge')).toBeNull();
  });

  it('groups the presentation workspace, control dock, and side panel around an active share', async () => {
    window.localStorage.setItem('babagan.viewer-transport', 'sfu');
    const remoteTrack = {
      kind: 'video',
      attach: vi.fn((element?: HTMLMediaElement) => element ?? document.createElement('video')),
      detach: vi.fn((element?: HTMLMediaElement) => element ?? [])
    };
    const controller = meetingController({
      remoteScreenShare: {
        track: remoteTrack,
        sharerIdentity: 'participant-2',
        sharerName: 'Ben'
      } as unknown as MeetingRoomState['remoteScreenShare']
    });

    render(<MeetingRoomPage
      slug="meeting-slug"
      join={{
        participantIdentity: 'participant-1', participantName: 'Ada',
        livekitUrl: 'wss://rtc.example.test', token: 'token', meetingExpiresAt: 10_000,
        permissions: { publishSources: ['microphone'] }
      }}
      controller={controller}
      meetingApi={{ ...unauthorizedMeetingApi(), authorizeHost: vi.fn(async () => undefined) }}
      listDevices={async () => []}
    />);

    const main = screen.getByRole('main');
    const stage = await screen.findByLabelText('Shared screen stage');
    const controls = screen.getByLabelText('Meeting controls');

    expect(main).toHaveClass('meeting-room-sharing');
    expect(stage.parentElement).toHaveClass('meeting-stage-shell');
    expect(stage.parentElement?.parentElement).toHaveClass('meeting-stage-column');
    expect(stage.parentElement?.parentElement?.parentElement).toHaveClass('meeting-workspace');
    await userEvent.click(screen.getByRole('button', { name: 'Participants' }));
    const participantDrawer = screen.getByRole('dialog', { name: 'Participants' });
    expect(participantDrawer).toContainElement(screen.getByRole('list', { name: 'Participants' }));
    await userEvent.click(screen.getByText('Meeting management'));
    expect(participantDrawer).toContainElement(await screen.findByRole('heading', { name: 'Host controls' }));
    expect(controls).toHaveClass('meeting-control-dock');
  });

  it('shows admin-password termination only after host authorization is rejected', async () => {
    const adminEnd = vi.fn(async () => undefined);
    render(<MeetingRoomPage
      slug="meeting-slug"
      join={{
        participantIdentity: 'participant-1', participantName: 'Ada',
        livekitUrl: 'wss://rtc.example.test', token: 'token', meetingExpiresAt: 10_000,
        permissions: { publishSources: ['microphone'] }
      }}
      controller={meetingController()}
      meetingApi={{ ...unauthorizedMeetingApi(), adminEnd }}
      listDevices={async () => []}
    />);

    await userEvent.click(screen.getByRole('button', { name: 'Participants' }));
    await userEvent.click(screen.getByText('Meeting management'));
    const input = await screen.findByLabelText('Admin password to end meeting');
    await userEvent.type(input, 'admin-secret');
    await userEvent.click(screen.getByRole('button', { name: 'End current meeting' }));
    expect(adminEnd).toHaveBeenCalledWith('meeting-slug', 'admin-secret');
  });

  it('does not show participant admin termination to an authenticated host', async () => {
    render(<MeetingRoomPage
      slug="meeting-slug"
      join={{
        participantIdentity: 'participant-1', participantName: 'Ada',
        livekitUrl: 'wss://rtc.example.test', token: 'token', meetingExpiresAt: 10_000,
        permissions: { publishSources: ['microphone'] }
      }}
      controller={meetingController()}
      meetingApi={{ ...unauthorizedMeetingApi(), authorizeHost: vi.fn(async () => undefined), adminEnd: vi.fn() }}
      listDevices={async () => []}
    />);

    await userEvent.click(screen.getByRole('button', { name: 'Participants' }));
    await userEvent.click(screen.getByText('Meeting management'));
    expect(await screen.findByRole('heading', { name: 'Host controls' })).toBeVisible();
    expect(screen.queryByLabelText('Admin password to end meeting')).not.toBeInTheDocument();
  });

  it('reflects server-pushed local publish permission in room authorization state', async () => {
    const room = {
      connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
      on: vi.fn(), off: vi.fn(), remoteParticipants: new Map(),
      localParticipant: {
        identity: 'participant-1', name: 'Ada', isMicrophoneEnabled: false,
        isScreenShareEnabled: false,
        permissions: { canPublishSources: [2, 3] }
      },
      switchActiveDevice: vi.fn(async () => true)
    } as unknown as LiveKitRoomAdapter;
    const controller = createRoomController(() => room);
    const states: MeetingRoomState[] = [];
    controller.subscribe((state) => states.push(state));

    await controller.connect({
      participantIdentity: 'participant-1', participantName: 'Ada',
      livekitUrl: 'wss://rtc.example.test', token: 'token', meetingExpiresAt: 10_000,
      permissions: { publishSources: ['microphone'] }
    });

    expect(states.at(-1)).toMatchObject({ screenShareAuthorized: true });
  });

  it('integrates host-authorized grant, capture, stage, and participant release in the room UI', async () => {
    const order: string[] = [];
    const { stream, video } = displayStream({ audio: true });
    const controller = meetingController();
    controller.publishScreenShare = vi.fn(async () => { order.push('publish'); });
    const releaseScreenShare = vi.fn(async () => undefined);
    controller.releaseScreenShare = releaseScreenShare;
    const releaseOwnShare = vi.fn(async () => undefined);
    const meetingApi = {
      authorizeHost: vi.fn(async () => undefined),
      verifyParticipantShare: vi.fn(async () => undefined),
      grantShare: vi.fn(async () => { order.push('grant'); }),
      releaseOwnShare,
      revokeShare: vi.fn(async () => undefined),
      kick: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined)
    };
    const getDisplayMedia = vi.fn(async () => { order.push('capture'); return stream; });
    type ScreenPageProps = MeetingRoomPageProps & {
      meetingApi: typeof meetingApi;
      getDisplayMedia: typeof getDisplayMedia;
    };
    const ScreenPage = MeetingRoomPage as ComponentType<ScreenPageProps>;

    render(<ScreenPage
      slug="meeting-slug"
      join={{
        participantIdentity: 'participant-1', participantName: 'Ada',
        livekitUrl: 'wss://rtc.example.test', token: 'token', meetingExpiresAt: 10_000,
        permissions: { publishSources: ['microphone'] }
      }}
      controller={controller}
      meetingApi={meetingApi}
      getDisplayMedia={getDisplayMedia}
      listDevices={async () => []}
    />);

    const share = await screen.findByRole('button', { name: 'Share screen' });
    await waitFor(() => expect(share).toBeEnabled());
    await userEvent.click(share);

    expect(order).toEqual(['grant', 'capture']);
    expect(await screen.findByLabelText("Ada's shared screen")).toBeVisible();

    video.dispatchEvent(new Event('ended'));
    await waitFor(() => expect(releaseOwnShare).toHaveBeenCalledOnce());
    expect(releaseScreenShare).not.toHaveBeenCalled();
    // The SFU publication runs on cloned tracks so stopping it cannot end the share source.
    expect(releaseScreenShare).not.toHaveBeenCalledWith(stream);
    expect(screen.getByRole('button', { name: 'Share screen' })).toBeEnabled();
  });

  it('asks how to handle monitor audio before publishing when browser isolation is unavailable', async () => {
    const { stream } = displayStream({ audio: true, displaySurface: 'monitor' });
    const controller = meetingController({ screenShareAuthorized: true });
    const publishScreenShare = vi.fn(async () => undefined);
    controller.publishScreenShare = publishScreenShare;
    const meetingApi = {
      authorizeHost: vi.fn(async () => undefined),
      verifyParticipantShare: vi.fn(async () => undefined),
      grantShare: vi.fn(async () => undefined),
      releaseOwnShare: vi.fn(async () => undefined),
      revokeShare: vi.fn(async () => undefined),
      kick: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined)
    };
    type AdaptiveScreenPageProps = MeetingRoomPageProps & {
      supportsOwnAudioRestriction: () => boolean;
    };
    const AdaptiveScreenPage = MeetingRoomPage as ComponentType<AdaptiveScreenPageProps>;

    render(<AdaptiveScreenPage
      slug="meeting-slug"
      join={{
        participantIdentity: 'participant-1', participantName: 'Ada',
        livekitUrl: 'wss://rtc.example.test', token: 'token', meetingExpiresAt: 10_000,
        permissions: { publishSources: ['microphone', 'screen_share', 'screen_share_audio'] }
      }}
      controller={controller}
      meetingApi={meetingApi}
      getDisplayMedia={async () => stream}
      supportsOwnAudioRestriction={() => false}
      listDevices={async () => []}
    />);

    const share = await screen.findByRole('button', { name: 'Share screen' });
    await waitFor(() => expect(share).toBeEnabled());
    await userEvent.click(share);

    expect(await screen.findByRole('dialog', { name: 'System audio echo protection' })).toBeVisible();
    expect(publishScreenShare).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Share without computer audio' }));

    await screen.findByLabelText("Ada's shared screen");
    expect(publishScreenShare).not.toHaveBeenCalled();
    expect(stream.getAudioTracks()).toHaveLength(0);
  });

  it('publishes video and computer audio with the matching LiveKit sources and bitrate', async () => {
    const publishTrack = vi.fn(async () => undefined);
    const unpublishTrack = vi.fn(async () => undefined);
    const room = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      on: vi.fn(), off: vi.fn(), remoteParticipants: new Map(),
      localParticipant: {
        identity: 'participant-1', name: 'Ada', isMicrophoneEnabled: false,
        isScreenShareEnabled: false, publishTrack, unpublishTrack
      },
      switchActiveDevice: vi.fn(async () => true)
    } as unknown as LiveKitRoomAdapter;
    const controller = createRoomController(() => room);
    await controller.connect({
      participantIdentity: 'participant-1', participantName: 'Ada',
      livekitUrl: 'wss://rtc.example.test', token: 'token', meetingExpiresAt: 10_000,
      permissions: { publishSources: ['microphone'] }
    });
    const { stream } = displayStream({ audio: true });
    const publisher = controller as unknown as {
      publishScreenShare(stream: MediaStream, options: {
        maxBitrate: number;
        frameRate: number;
        degradationPreference: RTCDegradationPreference;
        codec: 'auto' | 'h264' | 'vp8';
      }): Promise<void>;
      releaseScreenShare(stream: MediaStream): Promise<void>;
    };
    expect(publisher.publishScreenShare).toBeTypeOf('function');

    await publisher.publishScreenShare(stream, {
      maxBitrate: 15_000_000,
      frameRate: 60,
      degradationPreference: 'maintain-resolution',
      codec: 'h264'
    });
    await publisher.releaseScreenShare(stream);

    expect(publishTrack).toHaveBeenNthCalledWith(1, stream.getVideoTracks()[0], expect.objectContaining({
      source: 'screen_share',
      simulcast: true,
      backupCodec: false,
      screenShareEncoding: { maxBitrate: 15_000_000, maxFramerate: 60 },
      screenShareSimulcastLayers: [expect.objectContaining({
        width: 1280,
        height: 720,
        encoding: expect.objectContaining({ maxBitrate: 3_500_000, maxFramerate: 30 })
      })],
      degradationPreference: 'maintain-resolution',
      videoCodec: 'h264'
    }));
    expect(publishTrack).toHaveBeenNthCalledWith(2, stream.getAudioTracks()[0], expect.objectContaining({
      source: 'screen_share_audio'
    }));
    expect(unpublishTrack).toHaveBeenCalledTimes(2);
  });

  it('keeps the screen-share button disabled without server-backed authorization', () => {
    render(<MeetingControls
      connection="connected"
      microphoneEnabled={false}
      audioPlaybackBlocked={false}
      devices={[]}
      leaving={false}
      screenShareAuthorized={false}
      screenShareActive={false}
      screenShareBusy={false}
      onMicrophoneToggle={() => undefined}
      onMicrophoneDeviceChange={() => undefined}
      onSpeakerDeviceChange={() => undefined}
      onResumeAudio={() => undefined}
      onScreenShareToggle={() => undefined}
      onLeave={() => undefined}
    />);

    expect(screen.getByRole('button', { name: 'Share screen' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Share screen' }))
      .toHaveAttribute('title', 'A host must grant screen sharing before capture can start.');
  });

  it('renders selectable screen codecs and locks the choice while sharing', async () => {
    const onCodecChange = vi.fn();
    const rendered = render(<MeetingControls
      connection="connected"
      microphoneEnabled={false}
      audioPlaybackBlocked={false}
      devices={[]}
      leaving={false}
      screenShareAuthorized
      screenShareActive={false}
      screenShareBusy={false}
      screenCodec="h264"
      onMicrophoneToggle={() => undefined}
      onMicrophoneDeviceChange={() => undefined}
      onSpeakerDeviceChange={() => undefined}
      onResumeAudio={() => undefined}
      onScreenCodecChange={onCodecChange}
      onScreenShareToggle={() => undefined}
      onLeave={() => undefined}
    />);

    await userEvent.click(screen.getByText('Audio and sharing settings'));
    const selector = screen.getByLabelText('Screen-share codec');
    expect(selector).toHaveValue('h264');
    expect(screen.getByRole('option', { name: 'Auto' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'VP8' })).toBeVisible();
    await userEvent.selectOptions(selector, 'vp8');
    expect(onCodecChange).toHaveBeenCalledWith('vp8');

    rendered.rerender(<MeetingControls
      connection="connected" microphoneEnabled={false} audioPlaybackBlocked={false} devices={[]}
      leaving={false} screenShareAuthorized screenShareActive screenShareBusy={false}
      screenCodec="h264" onMicrophoneToggle={() => undefined}
      onMicrophoneDeviceChange={() => undefined} onSpeakerDeviceChange={() => undefined}
      onResumeAudio={() => undefined}
      onScreenCodecChange={onCodecChange} onScreenShareToggle={() => undefined} onLeave={() => undefined}
    />);
    expect(screen.getByLabelText('Screen-share codec')).toBeDisabled();
  });

  it('lets a remote viewer choose TURN or SFU transport', async () => {
    const onTransportChange = vi.fn();
    render(<MeetingControls
      connection="connected"
      microphoneEnabled={false}
      audioPlaybackBlocked={false}
      devices={[]}
      leaving={false}
      screenShareAuthorized
      screenShareActive={false}
      screenShareBusy={false}
      viewerTransportPreference="auto"
      viewerTransportPreferenceVisible
      onViewerTransportPreferenceChange={onTransportChange}
      onMicrophoneToggle={() => undefined}
      onMicrophoneDeviceChange={() => undefined}
      onSpeakerDeviceChange={() => undefined}
      onResumeAudio={() => undefined}
      onScreenShareToggle={() => undefined}
      onLeave={() => undefined}
    />);

    await userEvent.click(screen.getByText('Audio and sharing settings'));
    const selector = screen.getByLabelText('Viewer screen transport');
    expect(screen.getByRole('option', { name: 'TURN relay' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'SFU relay' })).toBeVisible();
    await userEvent.selectOptions(selector, 'turn');

    expect(onTransportChange).toHaveBeenCalledWith('turn');
  });


  it('lets a receiver adjust the aggregate call-audio volume', async () => {
    const onCallAudioVolumeChange = vi.fn();
    render(<MeetingControls
      connection="connected"
      microphoneEnabled={false}
      audioPlaybackBlocked={false}
      devices={[]}
      leaving={false}
      callAudioVolume={100}
      onCallAudioVolumeChange={onCallAudioVolumeChange}
      onMicrophoneToggle={() => undefined}
      onMicrophoneDeviceChange={() => undefined}
      onSpeakerDeviceChange={() => undefined}
      onResumeAudio={() => undefined}
      onLeave={() => undefined}
    />);

    await userEvent.click(screen.getByText('Audio and sharing settings'));
    const slider = screen.queryByRole('slider', { name: 'Call audio volume' });
    expect(slider).toHaveValue('100');
    if (!slider) return;

    fireEvent.change(slider, { target: { value: '35' } });
    expect(onCallAudioVolumeChange).toHaveBeenCalledWith(35);
  });

  it('shows shared-audio volume only while receiving a remote share', async () => {
    const onSharedAudioVolumeChange = vi.fn();
    const common = {
      connection: 'connected' as const,
      microphoneEnabled: false,
      audioPlaybackBlocked: false,
      devices: [],
      leaving: false,
      sharedAudioVolume: 100,
      onSharedAudioVolumeChange,
      onMicrophoneToggle: () => undefined,
      onMicrophoneDeviceChange: () => undefined,
      onSpeakerDeviceChange: () => undefined,
      onResumeAudio: () => undefined,
      onLeave: () => undefined
    };
    const rendered = render(<MeetingControls {...common} sharedAudioVolumeVisible={false} />);

    await userEvent.click(screen.getByText('Audio and sharing settings'));
    expect(screen.queryByRole('slider', { name: 'Shared audio volume' })).not.toBeInTheDocument();

    rendered.rerender(<MeetingControls {...common} sharedAudioVolumeVisible />);
    const slider = screen.queryByRole('slider', { name: 'Shared audio volume' });
    expect(slider).toHaveValue('100');
    if (!slider) return;

    fireEvent.change(slider, { target: { value: '45' } });
    expect(onSharedAudioVolumeChange).toHaveBeenCalledWith(45);
  });

  it('opens an inline call-volume control from the primary dock', async () => {
    const onCallAudioVolumeChange = vi.fn();
    render(<MeetingControls
      connection="connected"
      microphoneEnabled={false}
      audioPlaybackBlocked={false}
      devices={[]}
      leaving={false}
      callAudioVolume={72}
      onCallAudioVolumeChange={onCallAudioVolumeChange}
      onMicrophoneToggle={() => undefined}
      onMicrophoneDeviceChange={() => undefined}
      onSpeakerDeviceChange={() => undefined}
      onResumeAudio={() => undefined}
      onLeave={() => undefined}
    />);

    expect(screen.queryByRole('group', { name: 'Quick audio controls' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Call audio volume' }));

    const menu = screen.getByRole('group', { name: 'Quick audio controls' });
    expect(menu).toBeVisible();
    const slider = within(menu).getByRole('slider', { name: 'Call audio volume' });
    expect(slider).toHaveValue('72');
    fireEvent.change(slider, { target: { value: '35' } });
    expect(onCallAudioVolumeChange).toHaveBeenCalledWith(35);
    slider.focus();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Quick audio controls' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call audio volume' })).toHaveFocus();
  });

  it('shows a shared-volume shortcut and slider only for a remote share', async () => {
    const onSharedAudioVolumeChange = vi.fn();
    const common = {
      connection: 'connected' as const,
      microphoneEnabled: false,
      audioPlaybackBlocked: false,
      devices: [],
      leaving: false,
      sharedAudioVolume: 64,
      onSharedAudioVolumeChange,
      onMicrophoneToggle: () => undefined,
      onMicrophoneDeviceChange: () => undefined,
      onSpeakerDeviceChange: () => undefined,
      onResumeAudio: () => undefined,
      onLeave: () => undefined
    };
    const rendered = render(<MeetingControls {...common} sharedAudioVolumeVisible={false} />);

    expect(screen.queryByRole('button', { name: 'Shared audio volume' })).not.toBeInTheDocument();
    rendered.rerender(<MeetingControls {...common} sharedAudioVolumeVisible />);
    await userEvent.click(screen.getByRole('button', { name: 'Shared audio volume' }));

    const menu = screen.getByRole('group', { name: 'Quick audio controls' });
    const slider = within(menu).getByRole('slider', { name: 'Shared audio volume' });
    expect(slider).toHaveValue('64');
    fireEvent.change(slider, { target: { value: '45' } });
    expect(onSharedAudioVolumeChange).toHaveBeenCalledWith(45);
  });

  it('marks the mobile dock as wrapped when a P2P retry action is visible', () => {
    render(<MeetingControls
      connection="connected"
      microphoneEnabled={false}
      audioPlaybackBlocked={false}
      devices={[]}
      leaving={false}
      p2pRetryVisible
      onP2pRetry={() => undefined}
      onMicrophoneToggle={() => undefined}
      onMicrophoneDeviceChange={() => undefined}
      onSpeakerDeviceChange={() => undefined}
      onResumeAudio={() => undefined}
      onLeave={() => undefined}
    />);

    expect(screen.getByLabelText('Meeting controls')).toHaveAttribute('data-mobile-wrapped', 'true');
  });

  it('groups the three primary actions separately from adaptive sharing settings', async () => {
    const onBitrateChange = vi.fn();
    const common = {
      connection: 'connected' as const,
      microphoneEnabled: false,
      audioPlaybackBlocked: false,
      devices: [],
      leaving: false,
      screenShareAuthorized: true,
      screenShareBusy: false,
      screenCodec: 'h264' as const,
      screenBitrate: 8_000_000 as const,
      screenViewerCount: 2,
      onMicrophoneToggle: () => undefined,
      onMicrophoneDeviceChange: () => undefined,
      onSpeakerDeviceChange: () => undefined,
      onResumeAudio: () => undefined,
      onScreenCodecChange: () => undefined,
      onScreenBitrateChange: onBitrateChange,
      onScreenShareToggle: () => undefined,
      onLeave: () => undefined
    };
    const rendered = render(<MeetingControls {...common} screenShareActive={false} />);

    await userEvent.click(screen.getByText('Audio and sharing settings'));
    const primaryActions = screen.getByRole('group', { name: 'Primary meeting actions' });
    expect(primaryActions).toContainElement(screen.getByRole('button', { name: 'Unmute microphone' }));
    expect(primaryActions).toContainElement(screen.getByRole('button', { name: 'Share screen' }));
    expect(primaryActions).toContainElement(screen.getByRole('button', { name: 'Leave meeting' }));
    expect(screen.getByText('Adaptive screen share · 30–60 fps')).toBeVisible();
    expect(screen.getByRole('option', { name: 'Flow (1080p30, resolution first)' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Standard (1080p30, frame rate first)' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Motion (1080p60, frame rate first)' })).toBeVisible();

    const selector = screen.getByLabelText('Maximum screen-share bitrate');
    expect(selector).toHaveValue('8000000');
    expect(screen.getByRole('option', { name: '5 Mbps' })).toBeVisible();
    expect(screen.getByRole('option', { name: '8 Mbps' })).toBeVisible();
    expect(screen.getByRole('option', { name: '10 Mbps' })).toBeVisible();
    expect(screen.getByText('Suggested P2P bitrate cap per viewer: 8 Mbps for 2 online viewers.')).toBeVisible();

    await userEvent.selectOptions(selector, '10000000');
    expect(onBitrateChange).toHaveBeenCalledWith(10_000_000);

    rendered.rerender(<MeetingControls {...common} screenShareActive />);
    expect(screen.getByLabelText('Maximum screen-share bitrate')).toBeDisabled();
    expect(screen.queryByLabelText('Screen-share quality')).not.toBeInTheDocument();
  });

  it('requests adaptive 1080p60 capture in high-motion mode and prioritizes frame rate', async () => {
    const order: string[] = [];
    const { stream, video } = displayStream({ audio: true });
    const getDisplayMedia = vi.fn(async () => { order.push('capture'); return stream; });
    const publish = vi.fn(async () => { order.push('publish'); });
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => { order.push('grant'); }),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia,
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start('h264', 8_000_000, 'motion');

    expect(order).toEqual(['grant', 'capture', 'publish']);
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: {
        frameRate: { ideal: 60 }
      },
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        restrictOwnAudio: true
      },
      systemAudio: 'include',
      windowAudio: 'window',
      selfBrowserSurface: 'exclude'
    });
    expect(publish).toHaveBeenCalledWith(stream, {
      maxBitrate: 8_000_000,
      frameRate: 60,
      degradationPreference: 'maintain-framerate',
      codec: 'h264'
    });
    expect(stream.getVideoTracks()[0]?.contentHint).toBe('motion');
    expect(stream.getAudioTracks()[0]?.contentHint).toBe('music');
    expect(video.applyConstraints).toHaveBeenCalledWith({
      width: { max: 1920 }, height: { max: 1080 }, frameRate: { min: 60, ideal: 60, max: 60 }
    });
  });

  it('falls back to ideal capture cadence when the selected source rejects the 60fps minimum', async () => {
    const { stream, video } = displayStream({ audio: false });
    const apply = vi.mocked(video.applyConstraints).mockRejectedValueOnce(new DOMException('60fps unsupported', 'OverconstrainedError'));
    const publish = vi.fn(async () => undefined);
    const controller = createScreenShareController({ requestGrant: vi.fn(async () => undefined), releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia: vi.fn(async () => stream), publisher: { publish, release: vi.fn(async () => undefined) } });
    await controller.start('h264', 8_000_000, 'motion', 'browser');
    expect(apply.mock.calls).toEqual([
      [{ width: { max: 1920 }, height: { max: 1080 }, frameRate: { min: 60, ideal: 60, max: 60 } }],
      [{ width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 60 } }]
    ]);
    expect(publish).toHaveBeenCalledWith(stream, expect.objectContaining({ frameRate: 60, encodingEngine: 'browser' }));
    expect(controller.getState().status).toBe('sharing');
    expect(video.stop).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('requests adaptive 1080p60 capture in detail60 mode and preserves resolution', async () => {
    const order: string[] = [];
    const { stream, video } = displayStream({ audio: true });
    const getDisplayMedia = vi.fn(async () => { order.push('capture'); return stream; });
    const publish = vi.fn(async () => { order.push('publish'); });
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => { order.push('grant'); }),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia,
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start('h264', 8_000_000, 'detail60');

    expect(order).toEqual(['grant', 'capture', 'publish']);
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: {
        frameRate: { ideal: 60 }
      },
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        restrictOwnAudio: true
      },
      systemAudio: 'include',
      windowAudio: 'window',
      selfBrowserSurface: 'exclude'
    });
    expect(publish).toHaveBeenCalledWith(stream, {
      maxBitrate: 8_000_000,
      frameRate: 60,
      degradationPreference: 'maintain-resolution',
      codec: 'h264'
    });
    expect(stream.getVideoTracks()[0]?.contentHint).toBe('detail');
    expect(stream.getAudioTracks()[0]?.contentHint).toBe('music');
    expect(video.applyConstraints).toHaveBeenCalledWith({
      width: { max: 1920 }, height: { max: 1080 }, frameRate: { min: 60, ideal: 60, max: 60 }
    });
  });

  it('falls back to ideal cadence in detail60 when the source rejects the 60fps minimum', async () => {
    const { stream, video } = displayStream({ audio: false });
    const apply = vi.mocked(video.applyConstraints).mockRejectedValueOnce(new DOMException('60fps unsupported', 'OverconstrainedError'));
    const publish = vi.fn(async () => undefined);
    const controller = createScreenShareController({ requestGrant: vi.fn(async () => undefined), releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia: vi.fn(async () => stream), publisher: { publish, release: vi.fn(async () => undefined) } });
    await controller.start('h264', 8_000_000, 'detail60', 'browser');
    expect(apply.mock.calls).toEqual([
      [{ width: { max: 1920 }, height: { max: 1080 }, frameRate: { min: 60, ideal: 60, max: 60 } }],
      [{ width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 60 } }]
    ]);
    expect(publish).toHaveBeenCalledWith(stream, expect.objectContaining({ frameRate: 60, encodingEngine: 'browser' }));
    expect(controller.getState().status).toBe('sharing');
    expect(video.stop).not.toHaveBeenCalled();
    await controller.stop();
  });

  it('captures and publishes at the flow preset (resolution first, 1080p30)', async () => {
    const { stream } = displayStream({ audio: true });
    const getDisplayMedia = vi.fn(async () => stream);
    const publish = vi.fn(async () => undefined);
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia,
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start('h264', 8_000_000, 'flow');

    expect(stream.getVideoTracks()[0]?.contentHint).toBe('detail');
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({
      video: {
        frameRate: { ideal: 30 }
      }
    }));
    expect(publish).toHaveBeenCalledWith(stream, expect.objectContaining({
      frameRate: 30,
      degradationPreference: 'maintain-resolution'
    }));
  });

  it.each([
    [{ width: 3840, height: 2160 }, { width: { max: 1920 }, height: { max: 1080 } }],
    [{ width: 2560, height: 1080 }, { width: { max: 2560 }, height: { max: 1080 } }],
    [{ width: 1536, height: 864 }, { width: { max: 1536 }, height: { max: 864 } }],
    [{ width: 1080, height: 1920 }, { width: { max: 1080 }, height: { max: 1920 } }]
  ] as const)('bounds a flow capture to an orientation-aware 1080p box', async (source, bounds) => {
    const { stream, video } = displayStream({ audio: false, ...source });
    const publish = vi.fn(async () => undefined);
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia: vi.fn(async () => stream),
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start('h264', 8_000_000, 'flow');

    expect(video.applyConstraints).toHaveBeenCalledWith({
      ...bounds,
      frameRate: { ideal: 30 }
    });
  });

  it('defaults to the standard 1080p30 preset with frame-rate-first degradation', async () => {
    const { stream } = displayStream({ audio: true });
    const getDisplayMedia = vi.fn(async () => stream);
    const publish = vi.fn(async () => undefined);
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia,
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start('h264', 8_000_000);

    expect(stream.getVideoTracks()[0]?.contentHint).toBe('motion');
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({
      video: {
        frameRate: { ideal: 30 }
      }
    }));
    expect(publish).toHaveBeenCalledWith(stream, expect.objectContaining({
      frameRate: 30,
      degradationPreference: 'maintain-framerate'
    }));
  });

  it('uses orientation-aware max bounds rather than fixed 16:9 dimensions', async () => {
    const { stream, video } = displayStream({ audio: false, width: 1600, height: 1200 });
    const applyConstraints = vi.fn(async () => undefined);
    Object.assign(video, { applyConstraints });
    const publish = vi.fn(async () => undefined);
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia: vi.fn(async () => stream),
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start('h264', 8_000_000, 'standard');

    expect(applyConstraints).toHaveBeenCalledWith({
      width: { max: 1440 },
      height: { max: 1080 },
      frameRate: { ideal: 30 }
    });
  });

  it.each([
    [5_000_000],
    [8_000_000],
    [10_000_000]
  ] as const)('publishes adaptive sharing with the selected %i bps ceiling', async (selectedBitrate) => {
    const { stream } = displayStream({ audio: true });
    const publish = vi.fn(async () => undefined);
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia: vi.fn(async () => stream),
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start('h264', selectedBitrate);

    expect(publish).toHaveBeenCalledWith(stream, expect.objectContaining({
      maxBitrate: selectedBitrate
    }));
  });

  it('keeps monitor audio when the browser confirms own-audio restriction', async () => {
    const { stream, audio } = displayStream({ audio: true, displaySurface: 'monitor' });
    const applyConstraints = vi.fn(async () => undefined);
    Object.assign(audio!, {
      applyConstraints,
      getSettings: () => ({ restrictOwnAudio: true })
    });
    const publish = vi.fn(async () => undefined);
    const chooseUnrestrictedSystemAudio = vi.fn();
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia: vi.fn(async () => stream),
      supportsOwnAudioRestriction: () => true,
      chooseUnrestrictedSystemAudio,
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start();

    expect(applyConstraints).toHaveBeenCalledWith({ restrictOwnAudio: { exact: true } });
    expect(publish).toHaveBeenCalledWith(stream, expect.any(Object));
    expect(stream.getAudioTracks()).toEqual([audio]);
    expect(audio?.stop).not.toHaveBeenCalled();
    expect(chooseUnrestrictedSystemAudio).not.toHaveBeenCalled();
  });

  it('lets the user remove monitor audio when own-audio restriction is unavailable', async () => {
    const { stream, audio } = displayStream({ audio: true, displaySurface: 'monitor' });
    const publish = vi.fn(async () => undefined);
    const chooseUnrestrictedSystemAudio = vi.fn(async () => 'video-only' as const);
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia: vi.fn(async () => stream),
      supportsOwnAudioRestriction: () => false,
      chooseUnrestrictedSystemAudio,
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start();

    expect(chooseUnrestrictedSystemAudio).toHaveBeenCalledWith({ displaySurface: 'monitor' });
    expect(stream.getAudioTracks()).toHaveLength(0);
    expect(audio?.stop).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(stream, expect.any(Object));
    expect(controller.getState().audioGuidance).toMatch(/without computer audio.*echo/i);
  });

  it('keeps monitor audio when the user accepts the echo risk', async () => {
    const { stream, audio } = displayStream({ audio: true, displaySurface: 'monitor' });
    const publish = vi.fn(async () => undefined);
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia: vi.fn(async () => stream),
      supportsOwnAudioRestriction: () => false,
      chooseUnrestrictedSystemAudio: vi.fn(async () => 'share-audio' as const),
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start();

    expect(stream.getAudioTracks()).toEqual([audio]);
    expect(audio?.stop).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(stream, expect.any(Object));
    expect(controller.getState().audioGuidance).toMatch(/could not isolate.*echo risk/i);
  });

  it('cancels monitor sharing and releases the grant when the user chooses a browser tab instead', async () => {
    const { stream, video, audio } = displayStream({ audio: true, displaySurface: 'monitor' });
    const publish = vi.fn(async () => undefined);
    const releaseGrant = vi.fn(async () => undefined);
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant,
      getDisplayMedia: vi.fn(async () => stream),
      supportsOwnAudioRestriction: () => false,
      chooseUnrestrictedSystemAudio: vi.fn(async () => 'cancel' as const),
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start();

    expect(publish).not.toHaveBeenCalled();
    expect(video.stop).toHaveBeenCalledOnce();
    expect(audio?.stop).toHaveBeenCalledOnce();
    expect(releaseGrant).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({ status: 'idle', stream: undefined });
    expect(controller.getState().audioGuidance).toMatch(/browser tab.*tab audio/i);
  });

  it('does not capture or publish when the server grant is rejected', async () => {
    const getDisplayMedia = vi.fn();
    const publish = vi.fn();
    const controller = createScreenShareController({
      requestGrant: vi.fn().mockRejectedValue(new Error('not authorized')),
      releaseGrant: vi.fn(),
      getDisplayMedia,
      publisher: { publish, release: vi.fn() }
    });

    await expect(controller.start()).rejects.toThrow('not authorized');

    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({ status: 'idle', stream: undefined });
  });

  it('guides the user to choose a source and enable computer audio when no audio track is returned', async () => {
    const { stream } = displayStream({ audio: false });
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia: vi.fn(async () => stream),
      publisher: { publish: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
    });

    await controller.start();

    expect(controller.getState().audioGuidance).toMatch(/browser tab.*Share tab audio.*Entire screen.*system audio/i);
  });

  it('releases publication and grant on browser-ended video even when the release request fails', async () => {
    const { stream, video } = displayStream({ audio: true });
    const releaseGrant = vi.fn().mockRejectedValue(new Error('network offline'));
    const release = vi.fn(async () => undefined);
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant,
      getDisplayMedia: vi.fn(async () => stream),
      publisher: { publish: vi.fn(async () => undefined), release }
    });
    await controller.start();

    video.dispatchEvent(new Event('ended'));

    await waitFor(() => expect(controller.getState().status).toBe('idle'));
    await waitFor(() => expect(releaseGrant).toHaveBeenCalledOnce());
    expect(release).toHaveBeenCalledWith(stream);
    expect(controller.getState().stream).toBeUndefined();
  });

  it('handles a video track ending while LiveKit publication is still pending', async () => {
    const { stream, video } = displayStream({ audio: true });
    const publication = deferred<void>();
    const release = vi.fn(async () => undefined);
    const releaseGrant = vi.fn(async () => undefined);
    const publish = vi.fn(() => publication.promise);
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant,
      getDisplayMedia: vi.fn(async () => stream),
      publisher: { publish, release }
    });
    const starting = controller.start();
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());

    video.dispatchEvent(new Event('ended'));
    expect(controller.getState().status).toBe('stopping');
    publication.resolve();
    await starting;

    expect(release).toHaveBeenCalledWith(stream);
    expect(releaseGrant).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({ status: 'idle', stream: undefined });
  });

  it('aborts a start that is stopped while the grant is in flight', async () => {
    const grant = deferred<void>();
    const releaseGrant = vi.fn(async () => undefined);
    const getDisplayMedia = vi.fn();
    const publish = vi.fn();
    const controller = createScreenShareController({
      requestGrant: vi.fn(() => grant.promise),
      releaseGrant,
      getDisplayMedia,
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    const starting = controller.start();
    expect(controller.getState().status).toBe('starting');
    await controller.stop();
    grant.resolve();
    await starting;

    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(releaseGrant).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({ status: 'idle', stream: undefined });
  });

  it('aborts a start that is stopped while the source picker is open', async () => {
    const { stream, video } = displayStream({ audio: true });
    const grant = deferred<void>();
    const capture = deferred<MediaStream>();
    const releaseGrant = vi.fn(async () => undefined);
    const publish = vi.fn();
    const controller = createScreenShareController({
      requestGrant: vi.fn(() => grant.promise),
      releaseGrant,
      getDisplayMedia: vi.fn(() => capture.promise),
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    const starting = controller.start();
    grant.resolve();
    await Promise.resolve(); // grant continuation runs; the capture is now in flight
    await controller.stop();
    capture.resolve(stream);
    await starting;

    expect(video.stop).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(releaseGrant).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({ status: 'idle', stream: undefined });
  });

  it('does not resurrect a superseded start when its grant resolves late', async () => {
    const grant1 = deferred<void>();
    const grant2 = deferred<void>();
    const { stream } = displayStream({ audio: true });
    const capture = vi.fn(async () => stream);
    const releaseGrant = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);
    const requestGrant = vi.fn()
      .mockImplementationOnce(() => grant1.promise)
      .mockImplementationOnce(() => grant2.promise);
    const controller = createScreenShareController({
      requestGrant,
      releaseGrant,
      getDisplayMedia: capture,
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    const start1 = controller.start(); // grant#1 in flight
    await controller.stop();           // cancelled: idle, button re-enabled
    const start2 = controller.start(); // grant#2 in flight
    grant1.resolve();                  // start#1 resumes → must abort, not resurrect
    await start1;

    expect(capture).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe('starting'); // start#2's state untouched

    grant2.resolve();
    await start2;

    expect(capture).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(stream, expect.any(Object));
    expect(releaseGrant).toHaveBeenCalledTimes(1); // only start#1's abort released its grant
    expect(controller.getState()).toMatchObject({ status: 'sharing', stream });
  });

  it('does not resurrect a start superseded while its capture was in flight', async () => {
    const grant1 = deferred<void>();
    const grant2 = deferred<void>();
    const capture1 = deferred<MediaStream>();
    const { stream: stream1, video: video1 } = displayStream({ audio: true });
    const { stream: stream2 } = displayStream({ audio: true });
    const releaseGrant = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);
    const requestGrant = vi.fn()
      .mockImplementationOnce(() => grant1.promise)
      .mockImplementationOnce(() => grant2.promise);
    const getDisplayMedia = vi.fn()
      .mockImplementationOnce(() => capture1.promise)
      .mockImplementationOnce(async () => stream2);
    const controller = createScreenShareController({
      requestGrant,
      releaseGrant,
      getDisplayMedia,
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    const start1 = controller.start();
    grant1.resolve();
    await Promise.resolve();  // grant#1 continuation runs; capture#1 now in flight
    await controller.stop();  // cancelled: idle
    const start2 = controller.start(); // grant#2 in flight
    capture1.resolve(stream1); // start#1 resumes → must abort
    await start1;

    expect(video1.stop).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(controller.getState().status).toBe('starting');

    grant2.resolve();
    await start2;

    expect(publish).toHaveBeenCalledWith(stream2, expect.any(Object));
    expect(controller.getState()).toMatchObject({ status: 'sharing', stream: stream2 });
  });

  it('does not clobber a newer start when a superseded start fails', async () => {
    const grant1 = deferred<void>();
    const grant2 = deferred<void>();
    const capture1 = deferred<MediaStream>();
    const { stream } = displayStream({ audio: true });
    const releaseGrant = vi.fn(async () => undefined);
    const publish = vi.fn(async () => undefined);
    const requestGrant = vi.fn()
      .mockImplementationOnce(() => grant1.promise)
      .mockImplementationOnce(() => grant2.promise);
    const getDisplayMedia = vi.fn()
      .mockImplementationOnce(() => capture1.promise)
      .mockImplementationOnce(async () => stream);
    const controller = createScreenShareController({
      requestGrant,
      releaseGrant,
      getDisplayMedia,
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    const start1 = controller.start();
    grant1.resolve();
    await Promise.resolve();
    await controller.stop();
    const start2 = controller.start();
    capture1.reject(new Error('picker dismissed'));
    await start1;

    expect(controller.getState().status).toBe('starting'); // start#2 untouched

    grant2.resolve();
    await start2;

    expect(publish).toHaveBeenCalledWith(stream, expect.any(Object));
    expect(controller.getState()).toMatchObject({ status: 'sharing', stream });
  });
});

describe('screen stage', () => {
  it('preserves the shared source aspect ratio inside the stage', () => {
    const { stream } = displayStream({ audio: false });

    render(<ScreenStage stream={stream} sharerName="Ada" />);

    const video = screen.getByLabelText("Ada's shared screen");
    expect(video).toHaveStyle({ objectFit: 'contain' });
    expect((video as HTMLVideoElement).srcObject).toBe(stream);
  });

  it('offers a fullscreen control for the active shared screen', async () => {
    const { stream } = displayStream({ audio: false });
    render(<ScreenStage stream={stream} sharerName="Ada" />);
    const stage = screen.getByLabelText('Shared screen stage');
    const requestFullscreen = vi.fn(async () => undefined);
    Object.defineProperty(stage, 'requestFullscreen', { configurable: true, value: requestFullscreen });

    const fullscreenButton = screen.getByRole('button', { name: 'View shared screen fullscreen' });
    expect(fullscreenButton).toHaveTextContent('Full screen');
    await userEvent.click(fullscreenButton);

    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it('keeps WebRTC diagnostics inside the active fullscreen container only', () => {
    const { stream } = displayStream({ audio: false });
    const rendered = render(<ScreenStage stream={stream} sharerName="Ada">
      <WebRtcStatsPanel requestedCodec="h264" />
    </ScreenStage>);
    const stage = screen.getByLabelText('Shared screen stage');

    expect(stage).toContainElement(screen.getByText('WebRTC statistics'));

    rendered.rerender(<ScreenStage sharerName="Ada">
      <WebRtcStatsPanel requestedCodec="h264" />
    </ScreenStage>);
    expect(screen.queryByText('WebRTC statistics')).not.toBeInTheDocument();
  });

  it('keeps the fullscreen control mounted so stale browser events cannot remove it permanently', async () => {
    const { stream } = displayStream({ audio: false });
    render(<ScreenStage stream={stream} sharerName="Ada" />);
    const stage = screen.getByLabelText('Shared screen stage');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: stage });

    await act(async () => { document.dispatchEvent(new Event('fullscreenchange')); });

    expect(screen.getByRole('button', { name: 'View shared screen fullscreen' })).toBeInTheDocument();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  });

  it('attaches and detaches remote video through LiveKit so adaptive streaming can request the right layer', () => {
    const { stream } = displayStream({ audio: false });
    const track = {
      attach: vi.fn((element?: HTMLMediaElement) => {
        const video = element ?? document.createElement('video');
        video.srcObject = stream;
        return video;
      }),
      detach: vi.fn((element?: HTMLMediaElement) => element ?? [])
    };
    const RemoteTrackStage = ScreenStage as ComponentType<{
      track: typeof track;
      sharerName: string;
    }>;

    const rendered = render(<RemoteTrackStage track={track} sharerName="Ben" />);
    const video = screen.getByLabelText("Ben's shared screen");
    expect(track.attach).toHaveBeenCalledWith(video);

    rendered.unmount();
    expect(track.detach).toHaveBeenCalledWith(video);
  });

  it('attaches matching screen video and audio to one media element for timestamp-based synchronization', () => {
    const videoTracks: MediaStreamTrack[] = [];
    const audioTracks: MediaStreamTrack[] = [];
    const stream = {
      getVideoTracks: () => videoTracks,
      getAudioTracks: () => audioTracks
    } as unknown as MediaStream;
    const videoMediaTrack = eventTrack('video');
    const audioMediaTrack = eventTrack('audio');
    const videoTrack = {
      attach: vi.fn((element: HTMLMediaElement) => {
        videoTracks.push(videoMediaTrack);
        element.srcObject = stream;
        return element;
      }),
      detach: vi.fn((element: HTMLMediaElement) => element)
    };
    const audioTrack = {
      attach: vi.fn((element: HTMLMediaElement) => {
        audioTracks.push(audioMediaTrack);
        element.muted = false;
        return element;
      }),
      detach: vi.fn((element: HTMLMediaElement) => element)
    };
    const SynchronizedStage = ScreenStage as ComponentType<{
      track: typeof videoTrack;
      audioTrack: typeof audioTrack;
      sharerName: string;
    }>;

    const rendered = render(<SynchronizedStage
      track={videoTrack}
      audioTrack={audioTrack}
      sharerName="Ben"
    />);
    const video = screen.getByLabelText("Ben's shared screen") as HTMLVideoElement;

    expect(videoTrack.attach).toHaveBeenCalledWith(video);
    expect(audioTrack.attach).toHaveBeenCalledWith(video);
    expect(video.srcObject).toBe(stream);
    expect(video.muted).toBe(false);

    rendered.unmount();
    expect(audioTrack.detach).toHaveBeenCalledWith(video);
    expect(videoTrack.detach).toHaveBeenCalledWith(video);
  });

  it('shows the approved Chinese transport mode in WebRTC diagnostics', () => {
    render(<LanguageProvider initialLocale="zh-CN">
      <WebRtcStatsPanel requestedCodec="h264" mode="turn" />
    </LanguageProvider>);

    expect(screen.getByText('TURN 中继')).toBeVisible();
  });






  it('reports the replacement source ready only after its probe renders a frame', () => {
    const first = displayStream({ audio: false }).stream;
    const second = displayStream({ audio: false }).stream;
    const ready = vi.fn();
    const rendered = render(<ScreenStage stream={first} sharerName="Ada" onSourceReady={ready} />);
    const visible = screen.getByLabelText("Ada's shared screen");
    act(() => visible.dispatchEvent(new Event('playing')));
    expect(ready).toHaveBeenCalledOnce();

    rendered.rerender(<ScreenStage stream={second} sharerName="Ada" onSourceReady={ready} />);
    expect(ready).toHaveBeenCalledOnce();
    const probe = document.querySelector<HTMLVideoElement>('[data-stage-probe="true"]');
    expect(probe).not.toBeNull();
    act(() => probe?.dispatchEvent(new Event('playing')));

    expect(ready).toHaveBeenCalledTimes(2);
    expect((visible as HTMLVideoElement).srcObject).toBe(second);
  });
});

describe('host controls', () => {
  it('clears a stale host-menu grant when the same participant is no longer marked sharing', async () => {
    const properties = {
      authorizeHost: vi.fn().mockResolvedValue(undefined),
      onGrantShare: vi.fn(async () => undefined),
      onRevokeShare: vi.fn(async () => undefined),
      onKick: vi.fn(async () => undefined),
      onEndMeeting: vi.fn(async () => undefined)
    };
    const { rerender } = render(<HostMenu
      {...properties}
      participants={[
        { identity: 'participant-1', name: 'Ada', isSharing: true },
        { identity: 'participant-2', name: 'Lin', isSharing: false }
      ]}
    />);
    expect(await screen.findByRole('button', { name: 'Grant screen sharing to Lin' })).toBeDisabled();

    rerender(<HostMenu
      {...properties}
      participants={[
        { identity: 'participant-1', name: 'Ada', isSharing: false },
        { identity: 'participant-2', name: 'Lin', isSharing: false }
      ]}
    />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Grant screen sharing to Lin' })).toBeEnabled());
  });

  it('renders no management controls unless a host-authorized API request succeeds', async () => {
    const rejected = vi.fn().mockRejectedValue(new Error('not a host'));
    const { rerender } = render(<HostMenu
      participants={[{ identity: 'participant-1', name: 'Ada', isSharing: false }]}
      authorizeHost={rejected}
      onGrantShare={vi.fn()}
      onRevokeShare={vi.fn()}
      onKick={vi.fn()}
      onEndMeeting={vi.fn()}
    />);

    await waitFor(() => expect(rejected).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: /Kick Ada/ })).not.toBeInTheDocument();

    const authorized = vi.fn().mockResolvedValue(undefined);
    rerender(<HostMenu
      participants={[{ identity: 'participant-1', name: 'Ada', isSharing: false }]}
      authorizeHost={authorized}
      onGrantShare={vi.fn()}
      onRevokeShare={vi.fn()}
      onKick={vi.fn()}
      onEndMeeting={vi.fn()}
    />);
    expect(await screen.findByRole('button', { name: 'Kick Ada' })).toBeVisible();
  });

  it('offers grant, revoke, kick, and confirmed end only after host authorization', async () => {
    const grant = vi.fn(async () => undefined);
    const revoke = vi.fn(async () => undefined);
    const kick = vi.fn(async () => undefined);
    const end = vi.fn(async () => undefined);
    const confirmEnd = vi.fn(() => true);
    render(<HostMenu
      participants={[
        { identity: 'participant-1', name: 'Ada', isSharing: false },
        { identity: 'participant-2', name: 'Lin', isSharing: false }
      ]}
      authorizeHost={vi.fn().mockResolvedValue(undefined)}
      onGrantShare={grant}
      onRevokeShare={revoke}
      onKick={kick}
      onEndMeeting={end}
      confirmEnd={confirmEnd}
    />);

    await userEvent.click(await screen.findByRole('button', { name: 'Grant screen sharing to Ada' }));
    expect(await screen.findByRole('button', { name: 'Revoke screen sharing from Ada' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Grant screen sharing to Lin' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke screen sharing from Ada' }));
    await userEvent.click(screen.getByRole('button', { name: 'Kick Ada' }));
    await userEvent.click(screen.getByRole('button', { name: 'End meeting' }));

    expect(grant).toHaveBeenCalledWith('participant-1');
    expect(revoke).toHaveBeenCalledOnce();
    expect(kick).toHaveBeenCalledWith('participant-1');
    expect(confirmEnd).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it('notifies the room after the host successfully ends the meeting', async () => {
    const ended = vi.fn();
    render(<HostMenu
      participants={[]}
      authorizeHost={vi.fn().mockResolvedValue(undefined)}
      onGrantShare={vi.fn()}
      onRevokeShare={vi.fn()}
      onKick={vi.fn()}
      onEndMeeting={vi.fn().mockResolvedValue(undefined)}
      confirmEnd={() => true}
      onEnded={ended}
    />);

    await userEvent.click(await screen.findByRole('button', { name: 'End meeting' }));

    expect(ended).toHaveBeenCalledOnce();
  });

  it('disables the end button and shows progress while the end request runs', async () => {
    let resolveEnd!: () => void;
    const end = vi.fn(() => new Promise<void>((resolve) => { resolveEnd = resolve; }));
    render(<HostMenu
      participants={[]}
      authorizeHost={vi.fn().mockResolvedValue(undefined)}
      onGrantShare={vi.fn()}
      onRevokeShare={vi.fn()}
      onKick={vi.fn()}
      onEndMeeting={end}
      confirmEnd={() => true}
    />);

    await userEvent.click(await screen.findByRole('button', { name: 'End meeting' }));

    const progress = await screen.findByRole('button', { name: 'Ending meeting…' });
    expect(progress).toBeDisabled();

    resolveEnd();
    expect(await screen.findByRole('button', { name: 'End meeting' })).toBeEnabled();
  });

  it('treats an already-ended meeting as success and notifies the room', async () => {
    const ended = vi.fn();
    render(<HostMenu
      participants={[]}
      authorizeHost={vi.fn().mockResolvedValue(undefined)}
      onGrantShare={vi.fn()}
      onRevokeShare={vi.fn()}
      onKick={vi.fn()}
      onEndMeeting={vi.fn().mockRejectedValue(new ApiRequestError('ended elsewhere', 410, {
        error: { code: 'MEETING_EXPIRED', message: 'The meeting has expired.', correlationId: 'corr-1' }
      }))}
      confirmEnd={() => true}
      onEnded={ended}
    />);

    await userEvent.click(await screen.findByRole('button', { name: 'End meeting' }));

    await waitFor(() => expect(ended).toHaveBeenCalledOnce());
    expect(screen.queryByText('The host action could not be completed.')).not.toBeInTheDocument();
  });
});

describe('on-demand screen share publisher', () => {
  it('starts peer sessions without an SFU backup', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness(p2pViewers);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));
    expect(fake.start).toHaveBeenCalledWith(stream, p2pPublishOptions(8_000_000), p2pViewers);
    expect(sfuPublisher.publish).not.toHaveBeenCalled();
    fake.triggerFallback('viewer-1');
    expect(sfuPublisher.publish).not.toHaveBeenCalled();
  });
  it('does not publish screen media when no viewers are online', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness([]);
    await hybrid.publish(displayStream({ audio: true }).stream, p2pPublishOptions(8_000_000));
    expect(fake.start).not.toHaveBeenCalled(); expect(sfuPublisher.publish).not.toHaveBeenCalled();
  });
  it('publishes the explicit SFU tier only while requested', async () => {
    const { hybrid, sfuPublisher } = hybridHarness(p2pViewers);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));
    await hybrid.setViewerScreenTransport('viewer-1', 'sfu');
    expect(sfuPublisher.publish).toHaveBeenCalledWith(stream, expect.objectContaining({ maxBitrate: 10_000_000 }));
    await hybrid.setViewerScreenTransport('viewer-1', 'peer');
    expect(sfuPublisher.release).toHaveBeenCalledOnce();
  });
  it('does not publish SFU for a fallback bye', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness(p2pViewers);
    await hybrid.publish(displayStream({ audio: true }).stream, p2pPublishOptions(8_000_000));
    hybrid.handleViewerBye('viewer-1', 'fallback');
    expect(fake.handleViewerLeft).toHaveBeenCalledWith('viewer-1'); expect(sfuPublisher.publish).not.toHaveBeenCalled();
  });
  it('keeps the peer controller available after viewers leave', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness([p2pViewers[0]]);
    await hybrid.publish(displayStream({ audio: true }).stream, p2pPublishOptions(8_000_000));
    hybrid.viewerLeft('viewer-1'); fake.triggerAllViewersClosed();
    expect(fake.stop).not.toHaveBeenCalled(); expect(sfuPublisher.publish).not.toHaveBeenCalled();
  });
  it('starts a late peer viewer without creating an SFU backup', async () => {
    const { hybrid, fake, setViewers, sfuPublisher } = hybridHarness([]);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));
    setViewers(p2pViewers); hybrid.viewerRosterChanged(true);
    expect(fake.start).toHaveBeenCalledWith(stream, p2pPublishOptions(8_000_000), p2pViewers, true);
    expect(sfuPublisher.publish).not.toHaveBeenCalled();
  });
  it('releases explicit SFU once across repeated share stops', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness(p2pViewers);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000)); await hybrid.setViewerScreenTransport('viewer-1', 'sfu');
    await hybrid.release(stream); await hybrid.release(stream);
    expect(fake.stop).toHaveBeenCalledOnce(); expect(sfuPublisher.release).toHaveBeenCalledOnce();
  });
  it('suggests a bounded per-viewer peer bitrate', () => {
    expect(recommendP2pBitrate(3)).toBe(8_000_000); expect(recommendP2pBitrate(4)).toBe(5_000_000);
  });
  it('keeps the peer controller retryable when an explicit SFU viewer returns', async () => {
    const signaling: P2pShareSignaling = { sendOffer: vi.fn(), sendIce: vi.fn(), sendBye: vi.fn() };
    const viewer = p2pViewers[0];
    const hybrid = new HybridScreenSharePublisher({
      sfuPublisher: { publish: vi.fn(async () => undefined), release: vi.fn(async () => undefined) },
      getViewers: () => [viewer],
      createShareController: (hooks) => createP2pShareController({
        slug: 'meeting-slug', signaling, fetchIceServers: async () => [{ urls: ['stun:stun.example.test:3478'] }],
        createPeerConnection: () => new HybridShareFakePc() as unknown as RTCPeerConnection, ...hooks
      })
    });
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));
    await hybrid.setViewerScreenTransport(viewer.identity, 'sfu');
    await hybrid.setViewerScreenTransport(viewer.identity, 'peer');
    await waitFor(() => expect(signaling.sendOffer).toHaveBeenCalledTimes(2));
  });
});

describe('P2P-first screen sharing in the room', () => {
  it('waits for the first stale allocation to close across multiple rapid SFU generations', async () => {
    CfPagePc.instances = []; vi.stubGlobal('RTCPeerConnection', CfPagePc); vi.stubGlobal('MediaStream', CfPageStream);
    const late = deferred<Response>(); const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); requests.push(path);
      if (path.endsWith('/screen-sfu')) return Response.json({ available: true, publication: null });
      if (path.includes('/ice-servers')) return Response.json({ iceServers: [], turnProvider: 'coturn' });
      if (path.endsWith('/subscribe')) {
        const shareId = JSON.parse(String(init?.body)).shareId as string;
        if (shareId === 'first') return late.promise;
        return Response.json({ sessionId: shareId, shareId, sessionDescription: { type: 'offer', sdp: 'offer' }, tracks: [{ kind: 'video', mid: '7', trackName: 'screen' }] });
      }
      return new Response(null, { status: 204 });
    }));
    const signaling = fakeSignalingClient(); renderP2pRoom({ createSignalingClient: signaling.factory, shareControllerFactory: fakeShareControllerFactory });
    const publication = { shareId: 'first', sessionId: 'publisher', sharerIdentity: 'Ben', sharerName: 'Ben', tracks: [{ kind: 'video' as const, trackName: 'screen' }] };
    act(() => signaling.screenSfu(publication)); await waitFor(() => expect(requests.filter(p => p.endsWith('/subscribe'))).toHaveLength(1));
    await act(async () => signaling.screenSfu({ ...publication, shareId: 'second' }));
    await act(async () => signaling.screenSfu({ ...publication, shareId: 'third' }));
    expect(requests.filter(p => p.endsWith('/subscribe'))).toHaveLength(1);
    await act(async () => late.resolve(Response.json({ sessionId: 'late-first', shareId: 'first', sessionDescription: { type: 'offer', sdp: 'offer' }, tracks: [{ kind: 'video', mid: '7', trackName: 'screen' }] })));
    await waitFor(() => expect(requests.filter(p => p.endsWith('/subscribe'))).toHaveLength(2));
    expect(requests.some(p => p.endsWith('/sessions/late-first'))).toBe(true);
  });
  it('publishes Cloudflare once before viewers arrive and never creates peer or LiveKit backups', async () => {
    CfPagePc.instances = []; vi.stubGlobal('RTCPeerConnection', CfPagePc);
    const requests: Array<{ path: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); requests.push({ path, body: typeof init?.body === 'string' ? init.body : undefined });
      if (path.endsWith('/screen-sfu')) return Response.json({ available: true, publication: null });
      if (path.endsWith('/ice-servers') || path.includes('/ice-servers?')) return Response.json({ iceServers: [], turnProvider: 'coturn' });
      if (path.endsWith('/publish')) return Response.json({ sessionId: 'source', shareId: 'share', sessionDescription: { type: 'answer', sdp: 'answer' }, tracks: [{ kind: 'video', mid: '0', trackName: 'screen' }] });
      return new Response(null, { status: 204 });
    }));
    const signaling = fakeSignalingClient(); const controller = meetingController(); const share = fakeShareController(); const { stream } = displayStream({ audio: false });
    renderP2pRoom({ controller, getDisplayMedia: async () => stream, createSignalingClient: signaling.factory, shareControllerFactory: () => share.controller });
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await userEvent.selectOptions(screen.getByLabelText('Screen-share transport'), 'cloudflare-sfu');
    await userEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Share screen' }));
    await waitFor(() => expect(requests.filter(r => r.path.endsWith('/publish/ready'))).toHaveLength(1));
    act(() => signaling.welcome(fourViewers)); act(() => signaling.transport('viewer-1', 'sfu'));
    expect(requests.filter(r => r.path.endsWith('/publish'))).toHaveLength(1); expect(CfPagePc.instances).toHaveLength(1);
    expect(CfPagePc.instances[0].senders).toHaveLength(1); expect(share.start).not.toHaveBeenCalled(); expect(controller.publishScreenShare).not.toHaveBeenCalled();
    act(() => { CfPagePc.instances[0].connectionState = 'failed'; CfPagePc.instances[0].dispatchEvent(new Event('connectionstatechange')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Cloudflare SFU');
    await userEvent.click(screen.getByRole('button', { name: 'Retry Cloudflare SFU' }));
    await waitFor(() => expect(requests.filter(r => r.path.endsWith('/publish/ready'))).toHaveLength(2));
    expect(CfPagePc.instances[0].close).toHaveBeenCalled(); expect(share.start).not.toHaveBeenCalled(); expect(controller.publishScreenShare).not.toHaveBeenCalled();
    expect(stream.getVideoTracks()[0].stop).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Stop sharing screen' }));
    await waitFor(() => expect(requests.some(r => r.path.endsWith('/sessions/source'))).toBe(true));
  });
  it('subscribes from a late-join snapshot once, waits for real video and restores future viewer preference on withdrawal', async () => {
    CfPagePc.instances = []; vi.stubGlobal('RTCPeerConnection', CfPagePc); vi.stubGlobal('MediaStream', CfPageStream);
    window.localStorage.setItem('babagan.viewer-transport', 'sfu'); const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input); requests.push(path);
      if (path.endsWith('/screen-sfu')) return Response.json({ available: true, publication: null });
      if (path.includes('/ice-servers')) return Response.json({ iceServers: [], turnProvider: 'coturn' });
      if (path.endsWith('/subscribe')) return Response.json({ sessionId: 'receiver', shareId: 'share', sessionDescription: { type: 'offer', sdp: 'offer' }, tracks: [{ kind: 'video', mid: '7', trackName: 'screen' }] });
      return new Response(null, { status: 204 });
    }));
    const signaling = fakeSignalingClient(); const controller = meetingController();
    renderP2pRoom({ controller, createSignalingClient: signaling.factory, shareControllerFactory: fakeShareControllerFactory });
    const publication = { shareId: 'share', sessionId: 'publisher', sharerIdentity: 'Ben', sharerName: 'Ben', tracks: [{ kind: 'video' as const, trackName: 'screen' }] };
    act(() => { signaling.screenSfu(publication); signaling.welcome([]); });
    await waitFor(() => expect(requests.some(p => p.endsWith('/sessions/receiver/answer'))).toBe(true));
    act(() => { signaling.screenSfu(publication); signaling.welcome([]); });
    expect(requests.filter(p => p.endsWith('/subscribe'))).toHaveLength(1);
    const track = Object.assign(eventTrack('video'), { muted: true, readyState: 'live' });
    act(() => CfPagePc.instances[0].ontrack?.({ track, transceiver: { mid: '7' } } as unknown as RTCTrackEvent));
    expect(screen.queryByLabelText("Ben's shared screen")).not.toBeInTheDocument();
    act(() => { track.muted = false; track.dispatchEvent(new Event('unmute')); });
    expect(screen.queryByText('Now sharing: Ben')).not.toBeInTheDocument();
    const video = await screen.findByLabelText("Ben's shared screen"); act(() => video.dispatchEvent(new Event('playing')));
    expect(screen.getByText('Now sharing: Ben')).toBeVisible();
    act(() => signaling.screenSfu(null));
    await waitFor(() => expect(controller.setRemoteScreenShareSubscribed).toHaveBeenLastCalledWith(true));
    expect(requests.filter(p => p.endsWith('/subscribe'))).toHaveLength(1);
  });
  it('reasserts an explicit SFU choice while waiting for a share without needing a peer offer', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('babagan.viewer-transport', 'sfu');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ iceServers: [] }), { status: 200 })));
    const signaling = fakeSignalingClient();
    try {
      await act(async () => { renderP2pRoom({ createSignalingClient: signaling.factory, controller: meetingController(), shareControllerFactory: fakeShareControllerFactory }); });
      act(() => signaling.welcome([]));
      vi.mocked(signaling.client.sendScreenTransport).mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(signaling.client.sendScreenTransport).toHaveBeenCalledWith('sfu');
    } finally { cleanup(); vi.useRealTimers(); }
  });








  it('defaults the P2P bitrate to the suggestion for the online viewer count', async () => {
    const signaling = fakeSignalingClient();
    renderP2pRoom({
      meetingApi: authorizedMeetingApi(),
      createSignalingClient: signaling.factory,
      shareControllerFactory: fakeShareControllerFactory
    });
    act(() => signaling.welcome(fourViewers));

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const selector = screen.getByLabelText('Maximum screen-share bitrate');

    await waitFor(() => expect(selector).toHaveValue('5000000'));
    expect(screen.getByText('Suggested P2P bitrate cap per viewer: 5 Mbps for 4 online viewers.')).toBeVisible();
  });

  it('publishes a cloned LiveKit screen only on explicit demand and releases it on return to peer', async () => {
    const { stream } = displayStream({ audio: true });
    const controller = meetingController();
    const publishScreenShare = vi.fn(async () => undefined);
    controller.publishScreenShare = publishScreenShare;
    const releaseScreenShare = vi.fn(async () => undefined);
    controller.releaseScreenShare = releaseScreenShare;
    const signaling = fakeSignalingClient();
    const share = fakeShareController();

    renderP2pRoom({
      controller,
      meetingApi: authorizedMeetingApi(),
      getDisplayMedia: async () => stream,
      createSignalingClient: signaling.factory,
      shareControllerFactory: (deps) => { share.installHooks(deps); return share.controller; }
    });
    act(() => signaling.welcome([p2pViewers[0]]));

    const shareButton = await screen.findByRole('button', { name: 'Share screen' });
    await waitFor(() => expect(shareButton).toBeEnabled());
    await userEvent.click(shareButton);
    await waitFor(() => expect(share.start).toHaveBeenCalledOnce());

    act(() => share.triggerFallback('viewer-1'));
    expect(publishScreenShare).not.toHaveBeenCalled();
    act(() => signaling.transport('viewer-1', 'sfu'));
    await waitFor(() => expect(publishScreenShare).toHaveBeenCalledOnce());
    // The SFU publication runs on cloned tracks so stopping it cannot end the share source.
    expect(publishScreenShare).not.toHaveBeenCalledWith(stream, expect.anything());
    expect(publishScreenShare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      maxBitrate: 10_000_000
    }));

    act(() => signaling.transport('viewer-1', 'peer'));
    await waitFor(() => expect(releaseScreenShare).toHaveBeenCalledOnce());
  });

  it('stops the whole share when the host revokes it via share-gone', async () => {
    const { stream } = displayStream({ audio: true });
    const controller = meetingController();
    const releaseOwnShare = vi.fn(async () => undefined);
    const signaling = fakeSignalingClient();
    const share = fakeShareController();

    renderP2pRoom({
      controller,
      meetingApi: { ...authorizedMeetingApi(), releaseOwnShare },
      getDisplayMedia: async () => stream,
      createSignalingClient: signaling.factory,
      shareControllerFactory: (deps) => { share.installHooks(deps); return share.controller; }
    });
    act(() => signaling.welcome([p2pViewers[0]]));

    const shareButton = await screen.findByRole('button', { name: 'Share screen' });
    await waitFor(() => expect(shareButton).toBeEnabled());
    await userEvent.click(shareButton);
    await waitFor(() => expect(share.start).toHaveBeenCalledOnce());

    act(() => signaling.shareGone());

    await waitFor(() => expect(releaseOwnShare).toHaveBeenCalledOnce());
    expect(share.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Share screen' })).toBeEnabled();
  });

  it('cancels a start that is revoked by the host while the grant is in flight', async () => {
    const grant = deferred<void>();
    const capture = vi.fn();
    const releaseOwnShare = vi.fn(async () => undefined);
    const controller = meetingController();
    const signaling = fakeSignalingClient();
    const share = fakeShareController();

    renderP2pRoom({
      controller,
      meetingApi: {
        ...authorizedMeetingApi(),
        grantShare: vi.fn(() => grant.promise),
        releaseOwnShare
      },
      getDisplayMedia: capture,
      createSignalingClient: signaling.factory,
      shareControllerFactory: (deps) => { share.installHooks(deps); return share.controller; }
    });
    act(() => signaling.welcome([p2pViewers[0]]));

    const shareButton = await screen.findByRole('button', { name: 'Share screen' });
    await waitFor(() => expect(shareButton).toBeEnabled());
    await userEvent.click(shareButton);

    act(() => signaling.shareGone());
    await act(async () => { grant.resolve(); });

    await waitFor(() => expect(releaseOwnShare).toHaveBeenCalledOnce());
    expect(capture).not.toHaveBeenCalled();
    expect(share.start).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Share screen' })).toBeEnabled();
  });

  it('closes the viewer P2P session when the sharer leaves the room', async () => {
    PageFakePc.instances = [];
    let resolveIce!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/ice-servers')) {
        return new Promise<Response>((resolve) => { resolveIce = resolve; });
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));
    vi.stubGlobal('RTCPeerConnection', PageFakePc);
    const signaling = fakeSignalingClient();
    const controller = meetingController();
    renderP2pRoom({
      controller,
      meetingApi: authorizedMeetingApi(),
      createSignalingClient: signaling.factory,
      shareControllerFactory: fakeShareControllerFactory
    });

    await act(async () => {
      resolveIce(new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.example.test:3478'] }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }));
    });
    act(() => signaling.welcome([{ identity: 'sharer-1', nickname: 'Ben' }]));
    act(() => signaling.offer('sharer-1', 'offer-sdp'));

    await waitFor(() => expect(PageFakePc.instances[0]?.remoteDescriptions).toEqual([{ type: 'offer', sdp: 'offer-sdp' }]));
    const pc = PageFakePc.instances[0];
    expect(pc.closed).toBe(false);

    act(() => signaling.peerLeft('sharer-1'));

    expect(pc.closed).toBe(true);
    expect(controller.setRemoteScreenShareSubscribed).not.toHaveBeenCalledWith(true);
    expect(PageFakePc.instances).toHaveLength(1);
  });

  it('replays viewer offers and ICE in arrival order after ICE configuration becomes ready', async () => {
    let resolveIce!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/ice-servers')) {
        return new Promise<Response>((resolve) => { resolveIce = resolve; });
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));
    vi.stubGlobal('RTCPeerConnection', PageFakePc);
    const signaling = fakeSignalingClient();
    renderP2pRoom({
      meetingApi: authorizedMeetingApi(),
      createSignalingClient: signaling.factory,
      shareControllerFactory: fakeShareControllerFactory
    });

    act(() => {
      signaling.offer('sharer-1', 'offer-before-ice');
      signaling.ice('sharer-1', JSON.stringify({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }));
      signaling.ice('sharer-1', null);
    });
    expect(PageFakePc.instances).toHaveLength(0);

    await act(async () => {
      resolveIce(new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.example.test:3478'] }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }));
    });

    await waitFor(() => expect(PageFakePc.instances[0]?.remoteDescriptions).toEqual([
      { type: 'offer', sdp: 'offer-before-ice' }
    ]));
    await waitFor(() => expect(PageFakePc.instances[0]?.addedIceCandidates).toEqual([
      { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
      undefined
    ]));
  });

  it('serializes later viewer offers and ICE so a new offer cannot overtake the current exchange', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/ice-servers')) {
        return Promise.resolve(new Response(JSON.stringify({
          iceServers: [{ urls: ['stun:stun.example.test:3478'] }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));
    vi.stubGlobal('RTCPeerConnection', PageFakePc);
    const firstOffer = deferred<void>();
    PageFakePc.remoteDescriptionGate = firstOffer.promise;
    const signaling = fakeSignalingClient();
    renderP2pRoom({
      meetingApi: authorizedMeetingApi(),
      createSignalingClient: signaling.factory,
      shareControllerFactory: fakeShareControllerFactory
    });
    await waitFor(() => expect(signaling.client.connect).toHaveBeenCalled());

    act(() => {
      signaling.offer('sharer-1', 'offer-1');
      signaling.ice('sharer-1', JSON.stringify({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }));
      signaling.offer('sharer-1', 'offer-2');
      signaling.ice('sharer-1', JSON.stringify({ candidate: 'candidate:2', sdpMid: '0', sdpMLineIndex: 0 }));
    });

    await waitFor(() => expect(PageFakePc.instances).toHaveLength(1));
    await act(async () => { firstOffer.resolve(); });

    await waitFor(() => expect(PageFakePc.instances).toHaveLength(2));
    await waitFor(() => expect(PageFakePc.instances[0]?.addedIceCandidates).toEqual([
      { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }
    ]));
    await waitFor(() => expect(PageFakePc.instances[1]?.addedIceCandidates).toEqual([
      { candidate: 'candidate:2', sdpMid: '0', sdpMLineIndex: 0 }
    ]));
  });




  it('stops expired-session ICE refresh retries but preserves transient recovery', async () => {
    vi.useFakeTimers();
    const configuration = { iceServers: [{ urls: ['stun:stun.example.test:3478'] }],
      turnProvider: 'coturn', turnCredentialsExpiresAt: Math.floor(Date.now() / 1_000) + 61 };
    const fetchIce = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(configuration), { status: 200 }))
      .mockImplementation(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => String(input).endsWith('/screen-sfu') ? Promise.resolve(new Response(JSON.stringify({ available: false, publication: null }))) : fetchIce(input));
    const signaling = fakeSignalingClient();
    const rendered = renderP2pRoom({ createSignalingClient: signaling.factory,
      shareControllerFactory: fakeShareControllerFactory });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(fetchIce).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(fetchIce).toHaveBeenCalledTimes(3);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(fetchIce).toHaveBeenCalledTimes(3);
    } finally { rendered.unmount(); vi.useRealTimers(); }
  });




  it('cancels queued viewer signaling when the page unmounts', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/ice-servers')) {
        return Promise.resolve(new Response(JSON.stringify({
          iceServers: [{ urls: ['stun:stun.example.test:3478'] }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));
    vi.stubGlobal('RTCPeerConnection', PageFakePc);
    const firstOffer = deferred<void>();
    PageFakePc.remoteDescriptionGate = firstOffer.promise;
    const signaling = fakeSignalingClient();
    const rendered = renderP2pRoom({
      meetingApi: authorizedMeetingApi(),
      createSignalingClient: signaling.factory,
      shareControllerFactory: fakeShareControllerFactory
    });
    await waitFor(() => expect(signaling.client.connect).toHaveBeenCalled());

    act(() => {
      signaling.offer('sharer-1', 'offer-1');
      signaling.offer('sharer-1', 'offer-2');
    });
    await waitFor(() => expect(PageFakePc.instances).toHaveLength(1));

    rendered.unmount();
    await act(async () => { firstOffer.resolve(); });

    expect(PageFakePc.instances).toHaveLength(1);
    expect(PageFakePc.instances[0]?.closed).toBe(true);
  });

  it.each([
    { preference: 'auto', receiveOffer: true },
    { preference: 'turn', receiveOffer: true },
    { preference: 'auto', receiveOffer: false },
    { preference: 'turn', receiveOffer: false }
  ] as const)('retries from persisted SFU to $preference before a P2P session exists (offer: $receiveOffer)', async ({ preference, receiveOffer }) => {
    window.localStorage.setItem('babagan.viewer-transport', 'sfu');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      iceServers: [{ urls: ['stun:stun.example.test:3478'] }], turnProvider: 'coturn'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('RTCPeerConnection', PageFakePc);
    const signaling = fakeSignalingClient();
    const controller = meetingController({ remoteScreenShare: {
      track: { kind: 'video', attach: (element = document.createElement('video')) => element, detach: () => [] },
      sharerIdentity: 'sharer-1', sharerName: 'Ben'
    } });
    try {
      renderP2pRoom({ controller, createSignalingClient: signaling.factory,
        shareControllerFactory: fakeShareControllerFactory });
      await waitFor(() => expect(signaling.client.connect).toHaveBeenCalled());
      if (receiveOffer) await act(async () => signaling.offer('sharer-1', 'ignored-offer'));
      expect(PageFakePc.instances).toHaveLength(0);
      await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
      await userEvent.selectOptions(screen.getByLabelText('Viewer screen transport'), preference);
      expect(signaling.client.sendScreenTransport).toHaveBeenCalledWith('peer');
      await act(async () => signaling.offer('sharer-1', 'fresh-offer'));
      await waitFor(() => expect(signaling.client.sendAnswer).toHaveBeenCalledWith('sharer-1', 'answer-sdp'));
      expect(PageFakePc.instances[0]?.config?.iceTransportPolicy).toBe(preference === 'turn' ? 'relay' : 'all');
    } finally {
      window.localStorage.removeItem('babagan.viewer-transport');
    }
  });

  it('never displays or subscribes SFU while default P2P renders or recovers', async () => {
    PageFakePc.instances = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/ice-servers')) {
        return Promise.resolve(new Response(JSON.stringify({
          iceServers: [{ urls: ['stun:stun.example.test:3478'] }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));
    vi.stubGlobal('RTCPeerConnection', PageFakePc);
    const livekitStream = displayStream({ audio: false }).stream;
    const livekitTrack = {
      kind: 'video',
      attach: vi.fn((element: HTMLMediaElement) => { element.srcObject = livekitStream; return element; }),
      detach: vi.fn((element: HTMLMediaElement) => element)
    };
    const controller = meetingController({
      remoteScreenShare: {
        track: livekitTrack,
        sharerIdentity: 'sharer-1',
        sharerName: 'Ben'
      }
    });
    const setSubscribed = vi.mocked(controller.setRemoteScreenShareSubscribed);
    const signaling = fakeSignalingClient();
    renderP2pRoom({
      controller,
      meetingApi: authorizedMeetingApi(),
      createSignalingClient: signaling.factory,
      shareControllerFactory: fakeShareControllerFactory
    });
    await waitFor(() => expect(signaling.client.connect).toHaveBeenCalled());
    act(() => signaling.welcome([{ identity: 'sharer-1', nickname: 'Ben' }]));
    act(() => signaling.offer('sharer-1', 'offer-sdp'));
    await waitFor(() => expect(PageFakePc.instances).toHaveLength(1));
    const pc = PageFakePc.instances[0]!;
    const { stream: p2pStream, video: p2pVideo } = displayStream({ audio: false });
    Object.assign(p2pVideo, { muted: false });

    act(() => pc.ontrack?.({ track: p2pVideo, streams: [p2pStream] } as unknown as RTCTrackEvent));
    await waitFor(() => expect(document.querySelector<HTMLVideoElement>('.screen-stage video')?.srcObject).toBe(p2pStream));
    expect(livekitTrack.attach).not.toHaveBeenCalled();
    act(() => document.querySelector('.screen-stage video')?.dispatchEvent(new Event('playing')));
    await waitFor(() => expect(setSubscribed).toHaveBeenCalledWith(false));
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(screen.getByRole('button', { name: 'WebRTC data' }));
    expect(screen.getByText('Direct P2P', { selector: '.webrtc-transport-badge' })).toBeVisible();
    await waitFor(() => expect(screen.getByText('Receiver')).toBeInTheDocument());
    expect(screen.queryByText('Collecting statistics…')).not.toBeInTheDocument();

    act(() => {
      pc.iceConnectionState = 'failed';
      pc.oniceconnectionstatechange?.();
    });
    await waitFor(() => expect(signaling.client.sendRetry).toHaveBeenCalledWith('sharer-1'));
    expect(pc.closed).toBe(false);
    expect(setSubscribed).not.toHaveBeenCalledWith(true);
    expect(livekitTrack.attach).not.toHaveBeenCalled();
  });

  it('closes the viewer P2P session when the sharer disappears from a fresh welcome', async () => {
    PageFakePc.instances = [];
    let resolveIce!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/ice-servers')) {
        return new Promise<Response>((resolve) => { resolveIce = resolve; });
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));
    vi.stubGlobal('RTCPeerConnection', PageFakePc);
    const signaling = fakeSignalingClient();
    renderP2pRoom({
      meetingApi: authorizedMeetingApi(),
      createSignalingClient: signaling.factory,
      shareControllerFactory: fakeShareControllerFactory
    });

    await act(async () => {
      resolveIce(new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.example.test:3478'] }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }));
    });
    act(() => signaling.welcome([{ identity: 'sharer-1', nickname: 'Ben' }]));
    act(() => signaling.offer('sharer-1', 'offer-sdp'));

    await waitFor(() => expect(PageFakePc.instances[0]?.remoteDescriptions).toEqual([{ type: 'offer', sdp: 'offer-sdp' }]));
    const pc = PageFakePc.instances[0];

    act(() => signaling.welcome([{ identity: 'other', nickname: 'Zoe' }]));

    expect(pc.closed).toBe(true);
  });

  it('prunes sharer-side sessions for viewers missing from a fresh welcome roster', async () => {
    const { stream } = displayStream({ audio: true });
    const signaling = fakeSignalingClient();
    const share = fakeShareController();

    renderP2pRoom({
      meetingApi: authorizedMeetingApi(),
      getDisplayMedia: async () => stream,
      createSignalingClient: signaling.factory,
      shareControllerFactory: (deps) => { share.installHooks(deps); return share.controller; }
    });
    act(() => signaling.welcome(p2pViewers));

    const shareButton = await screen.findByRole('button', { name: 'Share screen' });
    await waitFor(() => expect(shareButton).toBeEnabled());
    await userEvent.click(shareButton);
    await waitFor(() => expect(share.start).toHaveBeenCalledOnce());

    act(() => signaling.welcome([p2pViewers[0]]));

    expect(share.handleViewerLeft).toHaveBeenCalledWith('viewer-2');
  });
  it('starts P2P negotiation without an SFU backup when viewers are online', async () => {
    const order: string[] = [];
    const { stream } = displayStream({ audio: true });
    const controller = meetingController();
    const publishScreenShare = vi.fn(async () => { order.push('sfu'); });
    controller.publishScreenShare = publishScreenShare;
    const signaling = fakeSignalingClient();
    const share = fakeShareController();
    share.start.mockImplementation(async () => { order.push('p2p'); });
    const meetingApi = {
      authorizeHost: vi.fn(async () => undefined),
      verifyParticipantShare: vi.fn(async () => undefined),
      grantShare: vi.fn(async () => { order.push('grant'); }),
      releaseOwnShare: vi.fn(async () => undefined),
      revokeShare: vi.fn(async () => undefined),
      kick: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined)
    };

    renderP2pRoom({
      controller,
      meetingApi,
      getDisplayMedia: async () => { order.push('capture'); return stream; },
      createSignalingClient: signaling.factory,
      shareControllerFactory: (deps) => {
        share.installHooks(deps);
        return share.controller;
      }
    });
    act(() => signaling.welcome(p2pViewers));

    const shareButton = await screen.findByRole('button', { name: 'Share screen' });
    await waitFor(() => expect(shareButton).toBeEnabled());
    await userEvent.click(shareButton);

    await waitFor(() => expect(order).toEqual(['grant', 'capture', 'p2p']));
    expect(publishScreenShare).not.toHaveBeenCalled();

    act(() => share.triggerStates([['viewer-1', 'turn']]));
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(screen.getByRole('button', { name: 'WebRTC data' }));
    expect(screen.getByText('TURN relay', { selector: '.webrtc-transport-badge' })).toBeVisible();
  });
  it.each([401, 403, 404, 410])('stops ICE retry traffic after terminal HTTP %i on initial fetch', async (status) => {
    vi.useFakeTimers();
    const fetchIce = vi.fn(async () => new Response('{}', { status }));
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => String(input).endsWith('/screen-sfu') ? Promise.resolve(Response.json({ available: false, publication: null })) : fetchIce());
    const signaling = fakeSignalingClient();
    const rendered = renderP2pRoom({ createSignalingClient: signaling.factory,
      shareControllerFactory: fakeShareControllerFactory });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(fetchIce).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      await act(async () => signaling.offer('sharer-1', 'offer', undefined, 'coturn'));
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(fetchIce).toHaveBeenCalledTimes(1);
    } finally { rendered.unmount(); vi.useRealTimers(); }
  });

});

describe('private P2P quality stats in the room', () => {
  it('does not upload collected stats when leaving', async () => {
    const order: string[] = [];
    const collector = createP2pStatsCollector({
      slug: 'meeting-slug',
      sessionId: 'anon-session-1',
      sendReport: vi.fn(async () => { order.push('report'); })
    });
    const leaveMeeting = vi.fn(async () => { order.push('leave'); });
    renderP2pRoom({
      createStatsCollector: () => collector,
      leaveMeeting,
      createSignalingClient: fakeSignalingClient().factory,
      shareControllerFactory: fakeShareControllerFactory
    });

    await userEvent.click(screen.getByRole('button', { name: 'Leave meeting' }));

    await waitFor(() => expect(order).toEqual(['leave']));
  });

  it('does not upload stats on unmount', async () => {
    const sendReport = vi.fn(async () => undefined);
    const collector = createP2pStatsCollector({
      slug: 'meeting-slug', sessionId: 'anon-session-1', sendReport
    });
    const { unmount } = renderP2pRoom({
      createStatsCollector: () => collector,
      createSignalingClient: fakeSignalingClient().factory,
      shareControllerFactory: fakeShareControllerFactory
    });

    unmount();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendReport).not.toHaveBeenCalled();
  });

  it('does not upload stats after leaving and then unmounting', async () => {
    const sendReport = vi.fn(async () => undefined);
    const collector = createP2pStatsCollector({
      slug: 'meeting-slug', sessionId: 'anon-session-1', sendReport
    });
    const { unmount } = renderP2pRoom({
      createStatsCollector: () => collector,
      createSignalingClient: fakeSignalingClient().factory,
      shareControllerFactory: fakeShareControllerFactory
    });

    await userEvent.click(screen.getByRole('button', { name: 'Leave meeting' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Leave meeting' })).toBeEnabled());

    unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendReport).not.toHaveBeenCalled();
  });
});

function displayStream(options: {
  audio: boolean;
  displaySurface?: string;
  width?: number;
  height?: number;
}) {
  const video = eventTrack('video');
  if (options.displaySurface || options.width || options.height) {
    Object.assign(video, {
      getSettings: () => ({
        ...(options.displaySurface ? { displaySurface: options.displaySurface } : {}),
        ...(options.width ? { width: options.width } : {}),
        ...(options.height ? { height: options.height } : {})
      })
    });
  }
  const audio = options.audio ? [eventTrack('audio')] : [];
  const tracks = [video, ...audio];
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => [video],
    getAudioTracks: () => audio,
    removeTrack: (track: MediaStreamTrack) => {
      const trackIndex = tracks.indexOf(track);
      if (trackIndex >= 0) tracks.splice(trackIndex, 1);
      const audioIndex = audio.indexOf(track);
      if (audioIndex >= 0) audio.splice(audioIndex, 1);
    }
  } as unknown as MediaStream;
  return { stream, video, audio: audio[0] };
}

function eventTrack(kind: 'audio' | 'video') {
  const target = new EventTarget();
  return Object.assign(target, {
    kind,
    stop: vi.fn(),
    clone: vi.fn(() => eventTrack(kind)),
    applyConstraints: vi.fn(async () => undefined)
  }) as unknown as MediaStreamTrack;
}

function meetingController(change: Partial<MeetingRoomState> = {}): MeetingRoomController {
  const state: MeetingRoomState = {
    connection: 'connected',
    participants: [{
      identity: 'participant-1', name: 'Ada', isLocal: true,
      microphoneEnabled: false, isSharing: false
    }],
    microphoneEnabled: false,
    audioPlaybackBlocked: false,
    screenShareAuthorized: false,
    ...change
  };
  return {
    connect: vi.fn(async () => undefined),
    setMicrophoneEnabled: vi.fn(async () => undefined),
    switchAudioOutput: vi.fn(async () => 'changed' as const),
    setCallAudioVolume: vi.fn(),
    publishScreenShare: vi.fn(async () => undefined),
    releaseScreenShare: vi.fn(async () => undefined),
    setRemoteScreenShareSubscribed: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    subscribe: vi.fn((listener: (value: MeetingRoomState) => void) => { listener(state); return () => undefined; }),
    resumeAudioPlayback: vi.fn(async () => undefined)
  };
}

function unauthorizedMeetingApi() {
  return {
    authorizeHost: vi.fn().mockRejectedValue(new Error('not a host')),
    verifyParticipantShare: vi.fn().mockRejectedValue(new Error('not authorized')),
    grantShare: vi.fn().mockRejectedValue(new Error('not a host')),
    releaseOwnShare: vi.fn(async () => undefined),
    revokeShare: vi.fn().mockRejectedValue(new Error('not a host')),
    kick: vi.fn().mockRejectedValue(new Error('not a host')),
    end: vi.fn().mockRejectedValue(new Error('not a host'))
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolver, rejecter) => { resolve = resolver; reject = rejecter; });
  return { promise, resolve, reject };
}

const p2pViewers: Peer[] = [
  { identity: 'viewer-1', nickname: 'Ada' },
  { identity: 'viewer-2', nickname: 'Ben' }
];

const fourViewers: Peer[] = [
  { identity: 'viewer-1', nickname: 'Ada' },
  { identity: 'viewer-2', nickname: 'Ben' },
  { identity: 'viewer-3', nickname: 'Carol' },
  { identity: 'viewer-4', nickname: 'Dan' }
];

function p2pPublishOptions(maxBitrate: number) {
  return {
    maxBitrate,
    frameRate: 60,
    degradationPreference: 'maintain-resolution' as const,
    codec: 'h264' as const
  };
}

interface FakeShareController {
  controller: P2pShareController;
  start: Mock<(stream: MediaStream, bitrate: number, viewers: Peer[]) => Promise<void>>;
  stop: Mock<() => Promise<void>>;
  handleViewerLeft: Mock<(identity: string) => void>;
  installHooks(hooks: {
    onViewerFallback: (identity: string) => void;
    onAllViewersClosed: () => void;
  }): void;
  triggerFallback(identity: string): void;
  triggerAllViewersClosed(): void;
  triggerStates(states: Array<[string, ViewerSessionState]>): void;
}

function fakeShareController(): FakeShareController {
  let fallback: ((identity: string) => void) | undefined;
  let allClosed: (() => void) | undefined;
  const subscribers = new Set<(states: ReadonlyMap<string, ViewerSessionState>) => void>();
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const handleAnswer = vi.fn(async () => undefined);
  const handleIce = vi.fn(async () => undefined);
  const handleMediaReady = vi.fn();
  const handleViewerLeft = vi.fn();
  const handleRetry = vi.fn();
  const retryAll = vi.fn(async () => undefined);
  const controller: P2pShareController = {
    start,
    stop,
    handleAnswer,
    handleIce,
    handleMediaReady,
    handleViewerLeft,
    handleRetry,
    retryAll,
    getViewerStates: () => new Map<string, ViewerSessionState>(),
    getStatsReports: async () => [],
    subscribe: (listener) => {
      subscribers.add(listener);
      listener(new Map());
      return () => { subscribers.delete(listener); };
    },

  };
  return {
    controller,
    start,
    stop,
    handleViewerLeft,
    installHooks: (hooks) => {
      fallback = hooks.onViewerFallback;
      allClosed = hooks.onAllViewersClosed;
    },
    triggerFallback: (identity) => fallback?.(identity),
    triggerAllViewersClosed: () => allClosed?.(),
    triggerStates: (states) => {
      const snapshot = new Map(states);
      for (const subscriber of subscribers) subscriber(snapshot);
    },

  };
}

function hybridHarness(viewers: Peer[]) {
  let roster = viewers;
  const sfuPublisher = {
    publish: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined)
  };
  const fake = fakeShareController();
  const createShareController = vi.fn((deps: {
    onViewerFallback: (identity: string) => void;
    onAllViewersClosed: () => void;
  }) => {
    fake.installHooks(deps);
    return fake.controller;
  });
  const hybrid = new HybridScreenSharePublisher({
    sfuPublisher,
    getViewers: () => roster,
    createShareController
  });
  return {
    hybrid,
    sfuPublisher,
    fake,
    createShareController,
    setViewers: (next: Peer[]) => { roster = next; }
  };
}

class HybridShareFakePc {
  iceConnectionState: RTCIceConnectionState = 'new';
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  readonly sender = {
    track: undefined as MediaStreamTrack | undefined,
    getParameters: () => ({ encodings: [{}] }) as RTCRtpSendParameters,
    setParameters: async () => undefined
  };

  addTransceiver(track: MediaStreamTrack): RTCRtpTransceiver {
    this.sender.track = track;
    return {
      sender: this.sender,
      setCodecPreferences: () => undefined
    } as unknown as RTCRtpTransceiver;
  }

  addTrack(): RTCRtpSender {
    return this.sender as unknown as RTCRtpSender;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async setLocalDescription(): Promise<void> {}

  async getStats(): Promise<RTCStatsReport> {
    return new Map() as unknown as RTCStatsReport;
  }

  close(): void {
    this.iceConnectionState = 'closed';
  }
}

class CfPageStream {
  private tracks: MediaStreamTrack[] = [];
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  addTrack(t: MediaStreamTrack) { this.tracks.push(t); }
}
class CfPagePc extends EventTarget {
  static instances: CfPagePc[] = [];
  connectionState = 'connected'; iceGatheringState = 'complete';
  localDescription?: RTCSessionDescriptionInit; ontrack?: (event: RTCTrackEvent) => void;
  senders: MediaStreamTrack[] = [];
  constructor() { super(); CfPagePc.instances.push(this); }
  addTransceiver(track: MediaStreamTrack) { this.senders.push(track); return { mid: String(this.senders.length - 1), setCodecPreferences: vi.fn(), sender: { getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} } }; }
  createOffer = async () => ({ type: 'offer', sdp: 'offer' });
  createAnswer = async () => ({ type: 'answer', sdp: 'answer' });
  setLocalDescription = async (description: RTCSessionDescriptionInit) => { this.localDescription = description; };
  setRemoteDescription = async () => {};
  close = vi.fn(); getStats = async () => new Map([['video', { type: 'outbound-rtp', kind: 'video', framesSent: 1 }]]);
}
class PageFakePc {
  static instances: PageFakePc[] = [];
  static remoteDescriptionGate: Promise<void> | undefined;
  config: RTCConfiguration;
  readonly configurationHistory: RTCConfiguration[] = [];
  closed = false;
  iceConnectionState: RTCIceConnectionState = 'new';
  remoteDescriptions: RTCSessionDescriptionInit[] = [];
  addedIceCandidates: Array<RTCIceCandidateInit | undefined> = [];
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  constructor(config: RTCConfiguration = {}) {
    this.config = config;
    this.configurationHistory.push(config);
    PageFakePc.instances.push(this);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await PageFakePc.remoteDescriptionGate;
    this.remoteDescriptions.push(description);
  }

  get remoteDescription(): RTCSessionDescription | null {
    return (this.remoteDescriptions.at(-1) ?? null) as RTCSessionDescription | null;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(): Promise<void> {}

  async addIceCandidate(candidate?: RTCIceCandidateInit | RTCIceCandidate): Promise<void> {
    this.addedIceCandidates.push(candidate === undefined ? undefined : candidate as RTCIceCandidateInit);
  }

  setConfiguration(configuration: RTCConfiguration): void {
    this.config = configuration;
    this.configurationHistory.push(configuration);
  }

  async getStats(): Promise<RTCStatsReport> {
    return new Map<string, RTCStats>([
      ['transport', { id: 'transport', type: 'transport', timestamp: 1, selectedCandidatePairId: 'pair' } as RTCStats],
      ['pair', {
        id: 'pair', type: 'candidate-pair', timestamp: 1, state: 'succeeded',
        localCandidateId: 'local', remoteCandidateId: 'remote'
      } as RTCStats],
      ['local', { id: 'local', type: 'local-candidate', timestamp: 1, candidateType: 'srflx' } as RTCStats],
      ['remote', { id: 'remote', type: 'remote-candidate', timestamp: 1, candidateType: 'host' } as RTCStats],
      ['video', {
        id: 'video', type: 'inbound-rtp', timestamp: 1, kind: 'video',
        bytesReceived: 1_200, framesDecoded: 3
      } as RTCStats]
    ]) as unknown as RTCStatsReport;
  }

  close(): void {
    this.closed = true;
  }
}

function fakeSignalingClient() {
  const wiring: { events?: P2pSignalingEvents } = {};
  const client = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(),
    sendOffer: vi.fn(),
    sendAnswer: vi.fn(),
    sendIce: vi.fn(),
    sendMediaReady: vi.fn(),
    sendRetry: vi.fn(),
    sendScreenTransport: vi.fn(),
    retryConnection: vi.fn(),
    sendBye: vi.fn()
  } as unknown as P2pSignalingClient;
  return {
    screenSfu: (publication: import('@meeting/contracts').CloudflareSfuPublication | null) => wiring.events?.onScreenSfu?.(publication),
    client,
    factory: (_slug: string, _identity: string, events: P2pSignalingEvents) => {
      wiring.events = events;
      return client;
    },
    welcome: (peers: Peer[]) => wiring.events?.onWelcome(peers),
    peerJoined: (peer: Peer) => wiring.events?.onPeerJoined(peer),
    peerLeft: (identity: string) => wiring.events?.onPeerLeft({ identity }),
    offer: (from: string, sdp: string, generation?: string, turnProvider?: 'coturn') =>
      wiring.events?.onOffer(from, sdp, generation, turnProvider),
    ice: (from: string, candidate: string | null) => wiring.events?.onIce(from, candidate),
    transport: (from: string, transport: 'peer' | 'sfu') => wiring.events?.onScreenTransport?.(from, transport),
    bye: (from: string, reason?: string) => wiring.events?.onBye(from, reason),
    shareGone: () => wiring.events?.onShareGone()
  };
}

function authorizedMeetingApi() {
  return {
    authorizeHost: vi.fn(async () => undefined),
    verifyParticipantShare: vi.fn(async () => undefined),
    grantShare: vi.fn(async () => undefined),
    releaseOwnShare: vi.fn(async () => undefined),
    revokeShare: vi.fn(async () => undefined),
    kick: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined)
  };
}

function fakeShareControllerFactory(deps: {
  onViewerFallback: (identity: string) => void;
  onAllViewersClosed: () => void;
}): P2pShareController {
  const fake = fakeShareController();
  fake.installHooks(deps);
  return fake.controller;
}

function renderP2pRoom(props: {
  controller?: MeetingRoomController;
  meetingApi?: MeetingRoomApi;
  getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
  createSignalingClient: (slug: string, identity: string, events: P2pSignalingEvents) => P2pSignalingClient;
  shareControllerFactory: (deps: {
    onViewerFallback: (identity: string) => void;
    onAllViewersClosed: () => void;
  }) => P2pShareController;
  createStatsCollector?: () => P2pStatsCollector;
  leaveMeeting?: (slug: string) => Promise<void>;
}) {
  const P2pRoomPage = MeetingRoomPage as ComponentType<MeetingRoomPageProps>;
  return render(<P2pRoomPage
    slug="meeting-slug"
    join={{
      participantIdentity: 'participant-1', participantName: 'Ada',
      livekitUrl: 'wss://rtc.example.test', token: 'token', meetingExpiresAt: 10_000,
      permissions: { publishSources: ['microphone'] }
    }}
    controller={props.controller ?? meetingController()}
    meetingApi={props.meetingApi ?? authorizedMeetingApi()}
    {...(props.getDisplayMedia ? { getDisplayMedia: props.getDisplayMedia } : {})}
    createSignalingClient={props.createSignalingClient}
    shareControllerFactory={props.shareControllerFactory}
    listDevices={async () => []}
    {...(props.createStatsCollector ? { createStatsCollector: props.createStatsCollector } : {})}
    {...(props.leaveMeeting ? { leaveMeeting: props.leaveMeeting } : {})}
  />);
}
