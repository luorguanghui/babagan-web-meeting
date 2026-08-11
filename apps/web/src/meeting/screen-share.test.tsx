import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ComponentType } from 'react';

import { HostMenu } from '../components/host-menu.js';
import { MeetingControls } from '../components/meeting-controls.js';
import { ScreenStage } from '../components/screen-stage.js';
import { WebRtcStatsPanel } from '../components/webrtc-stats-panel.js';
import { MeetingRoomPage, type MeetingRoomApi, type MeetingRoomPageProps } from '../pages/meeting-room-page.js';
import type { P2pShareController, ViewerSessionState } from './p2p-share-controller.js';
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
});

describe('controlled browser screen sharing', () => {
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
  });

  it('groups the presentation workspace, control dock, and side panel around an active share', async () => {
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
    const sideRail = screen.getByLabelText('Meeting side panel');
    const controls = screen.getByLabelText('Meeting controls');

    expect(main).toHaveClass('meeting-room-sharing');
    expect(stage.parentElement).toHaveClass('meeting-stage-shell');
    expect(stage.parentElement?.parentElement).toHaveClass('meeting-stage-column');
    expect(stage.parentElement?.parentElement?.parentElement).toHaveClass('meeting-workspace');
    expect(sideRail).toContainElement(screen.getByRole('heading', { name: 'Participants (1)' }));
    await userEvent.click(screen.getByText('Meeting management'));
    expect(sideRail).toContainElement(await screen.findByRole('heading', { name: 'Host controls' }));
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

    expect(order).toEqual(['grant', 'capture', 'publish']);
    expect(await screen.findByLabelText("Ada's shared screen")).toBeVisible();

    video.dispatchEvent(new Event('ended'));
    await waitFor(() => expect(releaseOwnShare).toHaveBeenCalledOnce());
    expect(releaseScreenShare).toHaveBeenCalledOnce();
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

    await waitFor(() => expect(publishScreenShare).toHaveBeenCalledOnce());
    // The SFU publication runs on cloned tracks so stopping it cannot end the share source.
    expect(publishScreenShare).not.toHaveBeenCalledWith(stream, expect.anything());
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
    expect(screen.getByText('Adaptive 1080p · 30–60 fps')).toBeVisible();

    const selector = screen.getByLabelText('Maximum screen-share bitrate');
    expect(selector).toHaveValue('8000000');
    expect(screen.getByRole('option', { name: '5 Mbps' })).toBeVisible();
    expect(screen.getByRole('option', { name: '8 Mbps' })).toBeVisible();
    expect(screen.getByRole('option', { name: '10 Mbps' })).toBeVisible();

    await userEvent.selectOptions(selector, '10000000');
    expect(onBitrateChange).toHaveBeenCalledWith(10_000_000);

    rendered.rerender(<MeetingControls {...common} screenShareActive />);
    expect(screen.getByLabelText('Maximum screen-share bitrate')).toBeDisabled();
    expect(screen.queryByLabelText('Screen-share quality')).not.toBeInTheDocument();
  });

  it('requests adaptive 1080p capture and prioritizes resolution after the grant', async () => {
    const order: string[] = [];
    const { stream } = displayStream({ audio: true });
    const getDisplayMedia = vi.fn(async () => { order.push('capture'); return stream; });
    const publish = vi.fn(async () => { order.push('publish'); });
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => { order.push('grant'); }),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia,
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start('h264', 8_000_000);

    expect(order).toEqual(['grant', 'capture', 'publish']);
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { width: 1920, height: 1080, frameRate: 60 },
      audio: { restrictOwnAudio: true },
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
    expect(controller.getState().status).toBe('idle');
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
});

describe('hybrid P2P-first screen share publisher', () => {
  it('starts P2P sessions with the online roster and bitrate before any SFU publish', async () => {
    const { hybrid, sfuPublisher, fake, createShareController } = hybridHarness(p2pViewers);
    const { stream } = displayStream({ audio: true });

    await hybrid.publish(stream, p2pPublishOptions(8_000_000));

    expect(createShareController).toHaveBeenCalledOnce();
    expect(fake.start).toHaveBeenCalledWith(stream, 8_000_000, p2pViewers);
    expect(sfuPublisher.publish).not.toHaveBeenCalled();
    expect(hybrid.getShareController()).toBe(fake.controller);
  });

  it('publishes via the SFU publisher at the fallback bitrate when no viewers are online', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness([]);
    const { stream } = displayStream({ audio: true });

    await hybrid.publish(stream, p2pPublishOptions(8_000_000));

    expect(fake.start).not.toHaveBeenCalled();
    expect(sfuPublisher.publish).toHaveBeenCalledWith(stream, expect.objectContaining({
      maxBitrate: 10_000_000,
      frameRate: 60,
      codec: 'h264'
    }));
  });

  it('publishes the SFU track when a viewer falls back and releases it once every viewer is on p2p', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness(p2pViewers);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));

    fake.triggerFallback('viewer-1');

    await waitFor(() => expect(sfuPublisher.publish).toHaveBeenCalledWith(stream, expect.objectContaining({
      maxBitrate: 10_000_000
    })));

    // viewer-1 re-establishes a fresh P2P session while viewer-2 stays on p2p
    fake.triggerStates([['viewer-1', 'p2p'], ['viewer-2', 'p2p']]);
    await waitFor(() => expect(sfuPublisher.release).toHaveBeenCalledWith(stream));
  });

  it('keeps the SFU publication for late joiners until every viewer is on p2p', async () => {
    const { hybrid, sfuPublisher, fake, setViewers } = hybridHarness([]);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));
    expect(sfuPublisher.publish).toHaveBeenCalledOnce();

    setViewers([p2pViewers[0]]);
    hybrid.viewerRosterChanged(); // late joiner arrives mid-share

    expect(fake.start).toHaveBeenCalledWith(stream, 8_000_000, [p2pViewers[0]]);
    expect(sfuPublisher.release).not.toHaveBeenCalled(); // still negotiating

    fake.triggerStates([['viewer-1', 'p2p']]);
    await waitFor(() => expect(sfuPublisher.release).toHaveBeenCalledWith(stream));
  });

  it('releases the SFU track when every fallback viewer leaves', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness([p2pViewers[0]]);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));
    fake.triggerFallback('viewer-1');
    await waitFor(() => expect(sfuPublisher.publish).toHaveBeenCalledOnce());

    hybrid.viewerLeft('viewer-1');

    await waitFor(() => expect(sfuPublisher.release).toHaveBeenCalledWith(stream));
  });

  it('closes the viewer session and keeps the SFU track when a viewer reports a fallback bye', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness(p2pViewers);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));

    hybrid.handleViewerBye('viewer-1', 'fallback');

    expect(fake.handleViewerLeft).toHaveBeenCalledWith('viewer-1');
    await waitFor(() => expect(sfuPublisher.publish).toHaveBeenCalledWith(stream, expect.objectContaining({
      maxBitrate: 10_000_000
    })));
  });

  it('stops the P2P sessions when every viewer has left but keeps the SFU track for fallback viewers', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness(p2pViewers);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));

    hybrid.handleViewerBye('viewer-1', 'fallback');
    hybrid.handleViewerBye('viewer-2', 'fallback');
    fake.triggerAllViewersClosed();

    expect(fake.stop).toHaveBeenCalledOnce();
    await waitFor(() => expect(sfuPublisher.publish).toHaveBeenCalledTimes(1)); // LiveKit stays for the fallback viewers
  });

  it('stops the P2P sessions and releases the SFU track when all viewers leave', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness([p2pViewers[0]]);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));

    hybrid.viewerLeft('viewer-1');
    fake.triggerAllViewersClosed();

    expect(fake.stop).toHaveBeenCalledOnce();
    expect(sfuPublisher.publish).not.toHaveBeenCalled();
    expect(sfuPublisher.release).not.toHaveBeenCalled(); // nothing was published via SFU
  });

  it('re-drives P2P sessions when a viewer joins mid-share', async () => {
    const { hybrid, fake, setViewers } = hybridHarness([p2pViewers[0]]);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));

    setViewers(p2pViewers);
    hybrid.viewerRosterChanged();

    expect(fake.start).toHaveBeenLastCalledWith(stream, 8_000_000, p2pViewers);
  });

  it('falls back to the SFU publisher when the P2P start fails', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness([p2pViewers[0]]);
    const { stream } = displayStream({ audio: true });
    fake.start.mockRejectedValueOnce(new Error('no ICE credentials'));

    await hybrid.publish(stream, p2pPublishOptions(8_000_000));

    expect(sfuPublisher.publish).toHaveBeenCalledWith(stream, expect.objectContaining({ maxBitrate: 10_000_000 }));
  });

  it('is idempotent across repeated releases on the P2P path', async () => {
    const { hybrid, sfuPublisher, fake } = hybridHarness([p2pViewers[0]]);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));

    await hybrid.release(stream);
    await hybrid.release(stream);

    expect(fake.stop).toHaveBeenCalledOnce();
    expect(sfuPublisher.release).not.toHaveBeenCalled();
  });

  it('releases the SFU publication once across repeated releases on the SFU path', async () => {
    const { hybrid, sfuPublisher } = hybridHarness([]);
    const { stream } = displayStream({ audio: true });
    await hybrid.publish(stream, p2pPublishOptions(8_000_000));

    await hybrid.release(stream);
    await hybrid.release(stream);

    expect(sfuPublisher.release).toHaveBeenCalledTimes(1);
  });

  it('suggests 8 Mbps for up to three viewers and 5 Mbps from four on', () => {
    expect(recommendP2pBitrate(0)).toBe(8_000_000);
    expect(recommendP2pBitrate(1)).toBe(8_000_000);
    expect(recommendP2pBitrate(3)).toBe(8_000_000);
    expect(recommendP2pBitrate(4)).toBe(5_000_000);
    expect(recommendP2pBitrate(6)).toBe(5_000_000);
  });
});

describe('P2P-first screen sharing in the room', () => {
  it('starts P2P negotiation after the grant and capture when viewers are online', async () => {
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
      shareControllerFactory: (deps) => { share.installHooks(deps); return share.controller; }
    });
    act(() => signaling.welcome(p2pViewers));

    const shareButton = await screen.findByRole('button', { name: 'Share screen' });
    await waitFor(() => expect(shareButton).toBeEnabled());
    await userEvent.click(shareButton);

    await waitFor(() => expect(order).toEqual(['grant', 'capture', 'p2p']));
    expect(publishScreenShare).not.toHaveBeenCalled();
  });

  it('defaults the P2P bitrate to the suggestion for the online viewer count', async () => {
    const signaling = fakeSignalingClient();
    renderP2pRoom({
      meetingApi: authorizedMeetingApi(),
      createSignalingClient: signaling.factory,
      shareControllerFactory: fakeShareControllerFactory
    });
    act(() => signaling.welcome(fourViewers));

    await userEvent.click(screen.getByText('Audio and sharing settings'));
    const selector = screen.getByLabelText('Maximum screen-share bitrate');

    await waitFor(() => expect(selector).toHaveValue('5000000'));
    expect(screen.getByText(/suggested 5 Mbps for 4 online viewers/)).toBeVisible();
  });

  it('publishes the LiveKit screen on viewer fallback and cancels it once every viewer is on p2p', async () => {
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
    await waitFor(() => expect(publishScreenShare).toHaveBeenCalledOnce());
    // The SFU publication runs on cloned tracks so stopping it cannot end the share source.
    expect(publishScreenShare).not.toHaveBeenCalledWith(stream, expect.anything());
    expect(publishScreenShare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      maxBitrate: 10_000_000
    }));

    act(() => share.triggerStates([['viewer-1', 'p2p']]));
    await waitFor(() => expect(releaseScreenShare).toHaveBeenCalledOnce());
    // The SFU publication runs on cloned tracks so stopping it cannot end the share source.
    expect(releaseScreenShare).not.toHaveBeenCalledWith(stream);
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
    expect(pc.closed).toBe(false);

    act(() => signaling.peerLeft('sharer-1'));

    expect(pc.closed).toBe(true);
    expect(PageFakePc.instances).toHaveLength(1);
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
});

describe('anonymous P2P quality stats reporting in the room', () => {
  it('reports the collected stats on leave, before the leave request revokes the session', async () => {
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

    await waitFor(() => expect(order).toEqual(['report', 'leave']));
  });

  it('reports once on unmount when the page is closed without a leave', async () => {
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

    await waitFor(() => expect(sendReport).toHaveBeenCalledOnce());
  });

  it('does not report twice when leaving and then unmounting', async () => {
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
    await waitFor(() => expect(sendReport).toHaveBeenCalledOnce());

    unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendReport).toHaveBeenCalledOnce();
  });
});

function displayStream(options: { audio: boolean; displaySurface?: string }) {
  const video = eventTrack('video');
  if (options.displaySurface) {
    Object.assign(video, { getSettings: () => ({ displaySurface: options.displaySurface }) });
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
  return Object.assign(target, { kind, stop: vi.fn(), clone: vi.fn(() => eventTrack(kind)) }) as unknown as MediaStreamTrack;
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
    publishScreenShare: vi.fn(async () => undefined),
    releaseScreenShare: vi.fn(async () => undefined),
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
  let subscriber: ((states: ReadonlyMap<string, ViewerSessionState>) => void) | undefined;
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const handleAnswer = vi.fn(async () => undefined);
  const handleIce = vi.fn(async () => undefined);
  const handleMediaReady = vi.fn();
  const handleViewerLeft = vi.fn();
  const controller: P2pShareController = {
    start,
    stop,
    handleAnswer,
    handleIce,
    handleMediaReady,
    handleViewerLeft,
    getViewerStates: () => new Map<string, ViewerSessionState>(),
    subscribe: (listener) => {
      subscriber = listener;
      listener(new Map());
      return () => { subscriber = undefined; };
    }
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
    triggerStates: (states) => subscriber?.(new Map(states))
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

class PageFakePc {
  static instances: PageFakePc[] = [];
  closed = false;
  iceConnectionState: RTCIceConnectionState = 'new';
  remoteDescriptions: RTCSessionDescriptionInit[] = [];
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  constructor() {
    PageFakePc.instances.push(this);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescriptions.push(description);
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(): Promise<void> {}

  async addIceCandidate(): Promise<void> {}

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
    sendBye: vi.fn()
  } as unknown as P2pSignalingClient;
  return {
    client,
    factory: (_slug: string, _identity: string, events: P2pSignalingEvents) => {
      wiring.events = events;
      return client;
    },
    welcome: (peers: Peer[]) => wiring.events?.onWelcome(peers),
    peerJoined: (peer: Peer) => wiring.events?.onPeerJoined(peer),
    peerLeft: (identity: string) => wiring.events?.onPeerLeft({ identity }),
    offer: (from: string, sdp: string) => wiring.events?.onOffer(from, sdp),
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
