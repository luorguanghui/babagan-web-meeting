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
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Volume' }));
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
    expect(within(toolbar).getAllByRole('button', { name: /volume/i })).toHaveLength(1);
    await userEvent.click(within(toolbar).getByRole('button', { name: 'Volume' }));

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
    const trigger = screen.getByRole('button', { name: 'Volume' });
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
    await userEvent.click(screen.getByRole('button', { name: 'Volume' }));

    view.rerender(<MeetingControls {...baseProps} includeSettings={false} sharedAudioVolumeVisible={false} />);

    expect(screen.queryByRole('slider', { name: 'Shared audio volume' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Shared audio volume' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Quick audio controls' })).getAllByRole('slider')).toHaveLength(1);
    expect(screen.getByRole('slider', { name: 'Call audio volume' })).toHaveValue('100');
  });

  it('keeps a closed popover only for its noninteractive 180 ms exit and returns focus immediately', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<MeetingControls {...baseProps} includeSettings={false} sharedAudioVolumeVisible />);
    const trigger = screen.getByRole('button', { name: 'Volume' });
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
    const trigger = screen.getByRole('button', { name: 'Volume' });
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
    expect(within(toolbar).getAllByRole('button', { name: /音量/ })).toHaveLength(1);
    await userEvent.click(within(toolbar).getByRole('button', { name: '音量' }));
    const menu = screen.getByRole('group', { name: '快速音量控制' });
    expect(within(menu).getByRole('slider', { name: '通话音频音量' })).toHaveValue('100');
    expect(within(menu).queryByRole('slider', { name: '共享音频音量' })).not.toBeInTheDocument();
  });
});

describe('grouped meeting settings', () => {
  it('separates audio and devices from starting-share settings without changing defaults', () => {
    render(<MeetingSettings {...baseProps} sharedAudioVolumeVisible onScreenSourceTransportChange={() => undefined} />);

    const audio = screen.getByRole('region', { name: 'Audio and devices' });
    expect(within(audio).getByRole('slider', { name: 'Call audio volume' })).toHaveValue('100');
    expect(within(audio).getByRole('slider', { name: 'Shared audio volume' })).toHaveValue('100');
    expect(within(audio).getByRole('combobox', { name: 'Microphone device' })).toHaveValue('');
    expect(within(audio).getByRole('combobox', { name: 'Speaker device' })).toHaveValue('');

    const sharing = screen.getByRole('region', { name: 'Starting my share' });
    expect(within(sharing).getByRole('combobox', { name: 'Screen-share transport' })).toHaveValue('p2p');
    expect(within(sharing).getByRole('combobox', { name: 'Screen quality' })).toHaveValue('standard');
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
    const receiving = screen.getByRole('region', { name: 'Receiving a screen' });
    expect(within(receiving).getByRole('combobox', { name: 'Viewer screen transport' })).toHaveValue('turn');
    expect(within(receiving).getAllByRole('combobox')).toHaveLength(1);

    view.rerender(<MeetingSettings {...props} viewerTransportPreferenceVisible onViewerTransportPreferenceChange={undefined} />);
    expect(screen.queryByRole('region', { name: 'Receiving a screen' })).not.toBeInTheDocument();
  });

  it.each([{ screenShareActive: true }, { screenShareBusy: true }])('keeps starting-share controls locked while sharing is active or busy: %j', (state) => {
    render(<MeetingSettings {...baseProps} {...state} onScreenSourceTransportChange={() => undefined} />);

    const sharing = screen.getByRole('region', { name: 'Starting my share' });
    for (const selector of within(sharing).getAllByRole('combobox')) expect(selector).toBeDisabled();
    const audio = screen.getByRole('region', { name: 'Audio and devices' });
    expect(within(audio).getByRole('slider', { name: 'Call audio volume' })).not.toBeDisabled();
    expect(within(audio).getByRole('combobox', { name: 'Microphone device' })).not.toBeDisabled();
  });

  it('provides the same semantic setting groups in Chinese', () => {
    render(<LanguageProvider initialLocale="zh-CN"><MeetingSettings {...baseProps}
      viewerTransportPreferenceVisible onViewerTransportPreferenceChange={() => undefined} /></LanguageProvider>);

    expect(screen.getByRole('region', { name: '音频与设备' })).toBeVisible();
    expect(screen.getByRole('region', { name: '接收屏幕' })).toBeVisible();
    expect(screen.getByRole('region', { name: '我发起共享时' })).toBeVisible();
  });
});
