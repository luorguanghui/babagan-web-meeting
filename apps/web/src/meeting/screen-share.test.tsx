import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';

import { HostMenu } from '../components/host-menu.js';
import { MeetingControls } from '../components/meeting-controls.js';
import { ScreenStage } from '../components/screen-stage.js';
import { WebRtcStatsPanel } from '../components/webrtc-stats-panel.js';
import { MeetingRoomPage, type MeetingRoomPageProps } from '../pages/meeting-room-page.js';
import {
  createRoomController,
  type LiveKitRoomAdapter,
  type MeetingRoomController,
  type MeetingRoomState
} from './room-controller.js';
import { captureProfiles, createScreenShareController } from './screen-share.js';

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
    expect(stage.parentElement).toHaveClass('meeting-stage-column');
    expect(stage.parentElement?.parentElement).toHaveClass('meeting-workspace');
    expect(sideRail).toContainElement(screen.getByRole('heading', { name: 'Participants (1)' }));
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
    expect(releaseScreenShare).toHaveBeenCalledWith(stream);
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

    await waitFor(() => expect(publishScreenShare).toHaveBeenCalledWith(stream, expect.any(Object)));
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
      degradationPreference: 'maintain-framerate',
      codec: 'h264'
    });
    await publisher.releaseScreenShare(stream);

    expect(publishTrack).toHaveBeenNthCalledWith(1, stream.getVideoTracks()[0], expect.objectContaining({
      source: 'screen_share',
      screenShareEncoding: { maxBitrate: 15_000_000, maxFramerate: 60 },
      degradationPreference: 'maintain-framerate',
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
      screenProfile="standard"
      onMicrophoneToggle={() => undefined}
      onMicrophoneDeviceChange={() => undefined}
      onSpeakerDeviceChange={() => undefined}
      onResumeAudio={() => undefined}
      onScreenProfileChange={() => undefined}
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
      screenProfile="standard"
      screenCodec="h264"
      onMicrophoneToggle={() => undefined}
      onMicrophoneDeviceChange={() => undefined}
      onSpeakerDeviceChange={() => undefined}
      onResumeAudio={() => undefined}
      onScreenProfileChange={() => undefined}
      onScreenCodecChange={onCodecChange}
      onScreenShareToggle={() => undefined}
      onLeave={() => undefined}
    />);

    const selector = screen.getByLabelText('Screen-share codec');
    expect(selector).toHaveValue('h264');
    expect(screen.getByRole('option', { name: 'Auto' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'VP8' })).toBeVisible();
    await userEvent.selectOptions(selector, 'vp8');
    expect(onCodecChange).toHaveBeenCalledWith('vp8');

    rendered.rerender(<MeetingControls
      connection="connected" microphoneEnabled={false} audioPlaybackBlocked={false} devices={[]}
      leaving={false} screenShareAuthorized screenShareActive screenShareBusy={false}
      screenProfile="standard" screenCodec="h264" onMicrophoneToggle={() => undefined}
      onMicrophoneDeviceChange={() => undefined} onSpeakerDeviceChange={() => undefined}
      onResumeAudio={() => undefined} onScreenProfileChange={() => undefined}
      onScreenCodecChange={onCodecChange} onScreenShareToggle={() => undefined} onLeave={() => undefined}
    />);
    expect(screen.getByLabelText('Screen-share codec')).toBeDisabled();
  });

  it('shows 10, 13, and 15 Mbps ceilings only for 1080p60 and locks the choice while sharing', async () => {
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
      screenBitrate: 10_000_000 as const,
      onMicrophoneToggle: () => undefined,
      onMicrophoneDeviceChange: () => undefined,
      onSpeakerDeviceChange: () => undefined,
      onResumeAudio: () => undefined,
      onScreenProfileChange: () => undefined,
      onScreenCodecChange: () => undefined,
      onScreenBitrateChange: onBitrateChange,
      onScreenShareToggle: () => undefined,
      onLeave: () => undefined
    };
    const rendered = render(<MeetingControls {...common} screenProfile="standard" screenShareActive={false} />);

    expect(screen.queryByLabelText('60fps bitrate ceiling')).not.toBeInTheDocument();

    rendered.rerender(<MeetingControls {...common} screenProfile="motion" screenShareActive={false} />);
    const selector = screen.getByLabelText('60fps bitrate ceiling');
    expect(selector).toHaveValue('10000000');
    expect(screen.getByRole('option', { name: '10 Mbps' })).toBeVisible();
    expect(screen.getByRole('option', { name: '13 Mbps' })).toBeVisible();
    expect(screen.getByRole('option', { name: '15 Mbps' })).toBeVisible();

    await userEvent.selectOptions(selector, '13000000');
    expect(onBitrateChange).toHaveBeenCalledWith(13_000_000);

    rendered.rerender(<MeetingControls {...common} screenProfile="motion" screenShareActive />);
    expect(screen.getByLabelText('60fps bitrate ceiling')).toBeDisabled();
  });

  it.each([
    ['standard', captureProfiles.standard, 8_000_000, 'detail', 'maintain-resolution'],
    ['motion', captureProfiles.motion, 10_000_000, 'motion', 'maintain-framerate']
  ] as const)('requests the exact %s 1080p capture and publish profile after the grant', async (
    profile,
    expected,
    maxBitrate,
    contentHint,
    degradationPreference
  ) => {
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

    await controller.start(profile);

    expect(order).toEqual(['grant', 'capture', 'publish']);
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { width: expected.width, height: expected.height, frameRate: expected.frameRate },
      audio: { restrictOwnAudio: true },
      systemAudio: 'include',
      windowAudio: 'window',
      selfBrowserSurface: 'exclude'
    });
    expect(publish).toHaveBeenCalledWith(stream, {
      maxBitrate,
      frameRate: expected.frameRate,
      degradationPreference,
      codec: 'h264'
    });
    expect(stream.getVideoTracks()[0]?.contentHint).toBe(contentHint);
  });

  it.each([
    ['motion', 13_000_000, 13_000_000],
    ['motion', 15_000_000, 15_000_000],
    ['standard', 15_000_000, 8_000_000]
  ] as const)('publishes %s sharing with the selected ceiling resolved to %i bps', async (
    profile,
    selectedBitrate,
    expectedBitrate
  ) => {
    const { stream } = displayStream({ audio: true });
    const publish = vi.fn(async () => undefined);
    const controller = createScreenShareController({
      requestGrant: vi.fn(async () => undefined),
      releaseGrant: vi.fn(async () => undefined),
      getDisplayMedia: vi.fn(async () => stream),
      publisher: { publish, release: vi.fn(async () => undefined) }
    });

    await controller.start(profile, 'h264', selectedBitrate);

    expect(publish).toHaveBeenCalledWith(stream, expect.objectContaining({
      maxBitrate: expectedBitrate
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

    await controller.start('motion');

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

    await controller.start('motion');

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

    await controller.start('motion');

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

    await controller.start('motion');

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

    await expect(controller.start('standard')).rejects.toThrow('not authorized');

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

    await controller.start('standard');

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
    await controller.start('motion');

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
    const starting = controller.start('motion');
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());

    video.dispatchEvent(new Event('ended'));
    expect(controller.getState().status).toBe('idle');
    publication.resolve();
    await starting;

    expect(release).toHaveBeenCalledWith(stream);
    expect(releaseGrant).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({ status: 'idle', stream: undefined });
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
  return Object.assign(target, { kind, stop: vi.fn() }) as unknown as MediaStreamTrack;
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
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}
