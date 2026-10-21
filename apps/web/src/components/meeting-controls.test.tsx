import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LanguageProvider } from '../i18n/i18n.js';
import { MeetingControls, MeetingSettings, type MeetingControlsProps } from './meeting-controls.js';

const baseProps: MeetingControlsProps = {
  connection: 'connected',
  microphoneEnabled: false,
  audioPlaybackBlocked: false,
  devices: [],
  leaving: false,
  onMicrophoneToggle: () => undefined,
  onMicrophoneDeviceChange: () => undefined,
  onSpeakerDeviceChange: () => undefined,
  onResumeAudio: () => undefined,
  onLeave: () => undefined
};

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('meeting dock audio controls', () => {
  it('opens call volume from one room-dock entry with the unchanged default', async () => {
    render(<MeetingControls {...baseProps} includeSettings={false} />);

    const toolbar = screen.getByRole('toolbar', { name: 'Primary meeting controls' });
    expect(within(toolbar).queryByRole('slider')).not.toBeInTheDocument();
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Audio and devices' }));
    expect(within(toolbar).getByRole('slider', { name: 'Call audio volume' })).toHaveValue('100');
    expect(within(toolbar).queryByRole('slider', { name: 'Shared audio volume' })).not.toBeInTheDocument();
  });

  it('lets a receiver adjust call and shared volume independently from the single volume entry', async () => {
    function ReceiverControls() {
      const [callVolume, setCallVolume] = useState(100);
      const [sharedVolume, setSharedVolume] = useState(100);
      return <MeetingControls {...baseProps} includeSettings={false} sharedAudioVolumeVisible
        callAudioVolume={callVolume} sharedAudioVolume={sharedVolume}
        onCallAudioVolumeChange={setCallVolume} onSharedAudioVolumeChange={setSharedVolume} />;
    }
    render(<ReceiverControls />);
    const toolbar = screen.getByRole('toolbar', { name: 'Primary meeting controls' });
    expect(within(toolbar).getAllByRole('button', { name: 'Audio and devices' })).toHaveLength(1);
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Audio and devices' }));

    const menu = screen.getByRole('group', { name: 'Quick audio controls' });
    const call = within(menu).getByRole('slider', { name: 'Call audio volume' });
    const shared = within(menu).getByRole('slider', { name: 'Shared audio volume' });
    expect(call).toHaveValue('100');
    expect(shared).toHaveValue('100');
    fireEvent.change(call, { target: { value: '35' } });
    expect(call).toHaveValue('35');
    expect(shared).toHaveValue('100');
    fireEvent.change(shared, { target: { value: '45' } });
    expect(call).toHaveValue('35');
    expect(shared).toHaveValue('45');
  });

  it('shows one slider per source only while the volume menu is open', async () => {
    render(<MeetingControls {...baseProps} includeSettings={false} sharedAudioVolumeVisible />);

    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'Audio and devices' });
    await userEvent.click(trigger);
    const menu = screen.getByRole('group', { name: 'Quick audio controls' });
    expect(within(menu).getAllByRole('slider')).toHaveLength(2);
    expect(screen.getAllByRole('slider')).toHaveLength(2);
    within(menu).getByRole('slider', { name: 'Shared audio volume' }).focus();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('group', { name: 'Quick audio controls' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('removes shared volume when a remote share ends without removing call volume', async () => {
    const view = render(<MeetingControls {...baseProps} includeSettings={false} sharedAudioVolumeVisible />);
    await userEvent.click(screen.getByRole('button', { name: 'Audio and devices' }));

    view.rerender(<MeetingControls {...baseProps} includeSettings={false} sharedAudioVolumeVisible={false} />);

    expect(screen.queryByRole('slider', { name: 'Shared audio volume' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Shared audio volume' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Quick audio controls' })).getAllByRole('slider')).toHaveLength(1);
    expect(screen.getByRole('slider', { name: 'Call audio volume' })).toHaveValue('100');
  });

  it('keeps a closed popover only for its noninteractive 180 ms exit and returns focus immediately', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<MeetingControls {...baseProps} includeSettings={false} sharedAudioVolumeVisible />);
    const trigger = screen.getByRole('button', { name: 'Audio and devices' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('group', { name: 'Quick audio controls' });
    within(menu).getByRole('slider', { name: 'Call audio volume' }).focus();

    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('group', { name: 'Quick audio controls' })).not.toBeInTheDocument();
    expect(menu).toBeInTheDocument();
    expect(menu).toHaveAttribute('data-state', 'exiting');
    expect(menu).toHaveAttribute('inert');
    expect(menu).toHaveAttribute('aria-hidden', 'true');
    act(() => { vi.advanceTimersByTime(179); });
    expect(menu).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(menu).not.toBeInTheDocument();
  });

  it('reopens a closing popover without a stale removal or duplicate sliders', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<MeetingControls {...baseProps} includeSettings={false} sharedAudioVolumeVisible />);
    const trigger = screen.getByRole('button', { name: 'Audio and devices' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('group', { name: 'Quick audio controls' });
    fireEvent.click(trigger);
    expect(menu).toHaveAttribute('data-state', 'exiting');
    act(() => { vi.advanceTimersByTime(70); });
    fireEvent.click(trigger);
    act(() => { vi.advanceTimersByTime(180); });

    expect(screen.getByRole('group', { name: 'Quick audio controls' })).toBe(menu);
    expect(menu).not.toHaveAttribute('inert');
    expect(menu).not.toHaveAttribute('aria-hidden', 'true');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(menu).getAllByRole('slider')).toHaveLength(2);
  });

  it('does not reserve an extra dock row just because shared audio is available', () => {
    const view = render(<MeetingControls {...baseProps} includeSettings={false} sharedAudioVolumeVisible />);
    expect(screen.getByLabelText('Meeting controls')).toHaveAttribute('data-mobile-wrapped', 'false');

    view.rerender(<MeetingControls {...baseProps} includeSettings={false} sharedAudioVolumeVisible p2pRetryVisible onP2pRetry={() => undefined} />);
    expect(screen.getByLabelText('Meeting controls')).toHaveAttribute('data-mobile-wrapped', 'true');
  });

  it('labels the single volume trigger in Chinese even without a remote share', async () => {
    render(<LanguageProvider initialLocale="zh-CN"><MeetingControls {...baseProps} includeSettings={false} /></LanguageProvider>);

    const toolbar = screen.getByRole('toolbar', { name: '主要会议控制' });
    expect(within(toolbar).getAllByRole('button', { name: '音频与设备' })).toHaveLength(1);
    await userEvent.click(within(toolbar).getByRole('button', { name: '音频与设备' }));
    const menu = screen.getByRole('group', { name: '快速音量控制' });
    expect(within(menu).getByRole('slider', { name: '通话音频音量' })).toHaveValue('100');
    expect(within(menu).queryByRole('slider', { name: '共享音频音量' })).not.toBeInTheDocument();
  });
});

describe('grouped meeting settings', () => {
  it('keeps advanced controls collapsed while quality stays visible with complete selected details', async () => {
    render(<MeetingSettings {...baseProps} onScreenSourceTransportChange={() => undefined} />);
    const quality = screen.getByRole('combobox', { name: 'Screen quality' });
    expect(quality).toHaveAccessibleDescription('Standard (1080p30, frame rate first)');
    expect(quality.closest('label')).toHaveClass('meeting-settings-field-wide');
    const advanced = screen.getByText('Advanced settings').closest('details');
    expect(advanced).not.toHaveAttribute('open');
    expect(advanced).toContainElement(screen.getByLabelText('Screen-share codec'));
    await userEvent.click(screen.getByText('Advanced settings'));
    expect(advanced).toHaveAttribute('open');
    expect(screen.getByRole('combobox', { name: 'Screen-share codec' })).toHaveValue('h264');
  });

  it('separates audio and devices from starting-share settings without changing defaults', () => {
    render(<MeetingSettings {...baseProps} sharedAudioVolumeVisible onScreenSourceTransportChange={() => undefined} />);

    fireEvent.click(screen.getByText('Advanced settings'));
    const audio = screen.getByRole('region', { name: 'Audio and devices' });
    expect(within(audio).getByRole('slider', { name: 'Call audio volume' })).toHaveValue('100');
    expect(within(audio).getByRole('slider', { name: 'Shared audio volume' })).toHaveValue('100');
    expect(within(audio).getByRole('combobox', { name: 'Microphone device' })).toHaveValue('');
    expect(within(audio).getByRole('combobox', { name: 'Speaker device' })).toHaveValue('');

    const sharing = screen.getByRole('region', { name: 'Starting my share' });
    expect(within(sharing).getByRole('combobox', { name: 'Screen-share transport' })).toHaveValue('p2p');
    expect(screen.getByRole('combobox', { name: 'Screen quality' })).toHaveValue('standard');
    expect(within(sharing).getByRole('combobox', { name: 'Screen-share codec' })).toHaveValue('h264');
    expect(within(sharing).getByRole('combobox', { name: 'Screen encoding engine' })).toHaveValue('browser');
    expect(within(sharing).getByRole('combobox', { name: 'Maximum screen-share bitrate' })).toHaveValue('8000000');
    expect(within(sharing).queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Receiving a screen' })).not.toBeInTheDocument();
  });

  it('shows receiving settings only when available and retains the supplied preference', () => {
    const props = { ...baseProps, viewerTransportPreference: 'turn' as const, onViewerTransportPreferenceChange: () => undefined };
    const view = render(<MeetingSettings {...props} viewerTransportPreferenceVisible={false} />);
    expect(screen.queryByRole('region', { name: 'Receiving a screen' })).not.toBeInTheDocument();

    view.rerender(<MeetingSettings {...props} viewerTransportPreferenceVisible />);
    fireEvent.click(screen.getByText('Advanced settings'));
    const receiving = screen.getByRole('region', { name: 'Receiving a screen' });
    expect(within(receiving).getByRole('combobox', { name: 'Viewer screen transport' })).toHaveValue('turn');
    expect(within(receiving).getAllByRole('combobox')).toHaveLength(1);

    view.rerender(<MeetingSettings {...props} viewerTransportPreferenceVisible onViewerTransportPreferenceChange={undefined} />);
    expect(screen.queryByRole('region', { name: 'Receiving a screen' })).not.toBeInTheDocument();
  });

  it.each([{ screenShareActive: true }, { screenShareBusy: true }])('keeps starting-share controls locked while sharing is active or busy: %j', (state) => {
    render(<MeetingSettings {...baseProps} {...state} onScreenSourceTransportChange={() => undefined} />);

    fireEvent.click(screen.getByText('Advanced settings'));
    const sharing = screen.getByRole('region', { name: 'Starting my share' });
    expect(screen.getByRole('combobox', { name: 'Screen quality' })).toBeDisabled();
    for (const selector of within(sharing).getAllByRole('combobox')) expect(selector).toBeDisabled();
    const audio = screen.getByRole('region', { name: 'Audio and devices' });
    expect(within(audio).getByRole('slider', { name: 'Call audio volume' })).not.toBeDisabled();
    expect(within(audio).getByRole('combobox', { name: 'Microphone device' })).not.toBeDisabled();
  });

  it('provides the same semantic setting groups in Chinese', () => {
    render(<LanguageProvider initialLocale="zh-CN"><MeetingSettings {...baseProps}
      viewerTransportPreferenceVisible onViewerTransportPreferenceChange={() => undefined} /></LanguageProvider>);

    fireEvent.click(screen.getByText('高级设置'));
    expect(screen.getByRole('region', { name: '音频与设备' })).toBeVisible();
    expect(screen.getByRole('region', { name: '接收屏幕' })).toBeVisible();
    expect(screen.getByRole('region', { name: '我发起共享时' })).toBeVisible();
  });
});


describe('split microphone and share quick controls', () => {
  it('keeps microphone and direct share actions separate from their adjacent settings triggers', async () => {
    const onMicrophoneToggle = vi.fn();
    const onScreenShareToggle = vi.fn();
    render(<MeetingControls {...baseProps} includeSettings={false} screenShareAuthorized onMicrophoneToggle={onMicrophoneToggle} onScreenShareToggle={onScreenShareToggle} />);
    const mic = screen.getByRole('button', { name: 'Unmute microphone' });
    const audio = screen.getByRole('button', { name: 'Audio and devices' });
    const share = screen.getByRole('button', { name: 'Share screen' });
    const shareSettings = screen.getByRole('button', { name: 'Screen sharing settings' });
    expect(mic.parentElement).toBe(audio.parentElement);
    expect(share.parentElement).toBe(shareSettings.parentElement);
    await userEvent.click(audio);
    expect(onMicrophoneToggle).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Microphone device' })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Screen quality' })).not.toBeInTheDocument();
    await userEvent.click(mic);
    expect(onMicrophoneToggle).toHaveBeenCalledOnce();
    await userEvent.click(share);
    expect(onScreenShareToggle).toHaveBeenCalledOnce();
    expect(screen.queryByRole('group', { name: 'Screen sharing settings' })).not.toBeInTheDocument();
    await userEvent.click(shareSettings);
    expect(onScreenShareToggle).toHaveBeenCalledOnce();
    expect(screen.getByRole('combobox', { name: 'Screen quality' })).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Microphone device' })).not.toBeInTheDocument();
  });

  it('shows only one quick panel and restores its trigger on Escape and an outside pointer', async () => {
    render(<MeetingControls {...baseProps} includeSettings={false} />);
    const audio = screen.getByRole('button', { name: 'Audio and devices' });
    const share = screen.getByRole('button', { name: 'Screen sharing settings' });
    await userEvent.click(audio);
    await userEvent.click(share);
    expect(audio).toHaveAttribute('aria-expanded', 'false');
    expect(share).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('group', { name: 'Quick audio controls' })).not.toBeInTheDocument();
    screen.getByRole('combobox', { name: 'Screen quality' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(share).toHaveFocus();
    await userEvent.click(audio);
    screen.getByRole('combobox', { name: 'Microphone device' }).focus();
    await act(async () => { fireEvent.pointerDown(document.body); });
    expect(screen.queryByRole('group', { name: 'Quick audio controls' })).not.toBeInTheDocument();
    expect(audio).toHaveFocus();
  });

  it('supports controlled panels so More and page settings can dismiss quick controls', async () => {
    const onQuickPanelChange = vi.fn();
    const view = render(<MeetingControls {...baseProps} includeSettings={false} quickPanel={null} onQuickPanelChange={onQuickPanelChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Audio and devices' }));
    expect(onQuickPanelChange).toHaveBeenCalledWith('audio');
    expect(screen.queryByRole('group', { name: 'Quick audio controls' })).not.toBeInTheDocument();
    view.rerender(<MeetingControls {...baseProps} includeSettings={false} quickPanel="share" onQuickPanelChange={onQuickPanelChange} />);
    expect(screen.getByRole('group', { name: 'Screen sharing settings' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(onQuickPanelChange).toHaveBeenLastCalledWith(null);
    view.rerender(<MeetingControls {...baseProps} includeSettings={false} quickPanel={null} onQuickPanelChange={onQuickPanelChange} />);
    expect(screen.queryByRole('group', { name: 'Screen sharing settings' })).not.toBeInTheDocument();
  });

  it('remembers selected real audio devices after closing and switching quick panels', async () => {
    const devices = [
      { deviceId: 'mic-1', kind: 'audioinput', label: 'USB microphone' },
      { deviceId: 'speaker-1', kind: 'audiooutput', label: 'Desk speakers' }
    ] as MediaDeviceInfo[];
    const onMicrophoneDeviceChange = vi.fn();
    const onSpeakerDeviceChange = vi.fn();
    render(<MeetingControls {...baseProps} includeSettings={false} devices={devices} onMicrophoneDeviceChange={onMicrophoneDeviceChange} onSpeakerDeviceChange={onSpeakerDeviceChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Audio and devices' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Microphone device' }), 'mic-1');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Speaker device' }), 'speaker-1');
    expect(onMicrophoneDeviceChange).toHaveBeenCalledWith('mic-1');
    expect(onSpeakerDeviceChange).toHaveBeenCalledWith('speaker-1');
    await userEvent.click(screen.getByRole('button', { name: 'Screen sharing settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Audio and devices' }));
    expect(screen.getByRole('combobox', { name: 'Microphone device' })).toHaveValue('mic-1');
    expect(screen.getByRole('combobox', { name: 'Speaker device' })).toHaveValue('speaker-1');
  });

  it('only shows a locked hint while this user is sharing or a share operation is busy', () => {
    const view = render(<MeetingSettings {...baseProps} section="share" sharedAudioVolumeVisible />);
    expect(screen.queryByText('Sharing settings cannot be changed during a share.')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Screen quality' })).toBeEnabled();
    view.rerender(<MeetingSettings {...baseProps} section="share" screenShareActive />);
    expect(screen.getByText('Sharing settings cannot be changed during a share.')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Screen quality' })).toBeDisabled();
  });

  it('keeps general settings receiver-only with a working diagnostics action', async () => {
    const onOpenDiagnostics = vi.fn();
    const onViewerTransportPreferenceChange = vi.fn();
    render(<MeetingSettings {...baseProps} section="general" viewerTransportPreferenceVisible viewerTransportPreference="turn" onViewerTransportPreferenceChange={onViewerTransportPreferenceChange} onOpenDiagnostics={onOpenDiagnostics} />);
    expect(screen.getByRole('combobox', { name: 'Viewer screen transport' })).toHaveValue('turn');
    expect(screen.queryByRole('combobox', { name: 'Screen quality' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Microphone device' })).not.toBeInTheDocument();
    expect(screen.queryByText('Advanced settings')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Viewer screen transport' }), 'sfu');
    expect(onViewerTransportPreferenceChange).toHaveBeenCalledWith('sfu');
    await userEvent.click(screen.getByRole('button', { name: 'WebRTC data' }));
    expect(onOpenDiagnostics).toHaveBeenCalledOnce();
  });
});
