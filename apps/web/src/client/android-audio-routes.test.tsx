import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientAudioRoutes, ClientHostEvent, JoinMeetingResponse } from '@meeting/contracts';
import type { ClientHost } from './host-bridge.js';
import type { ClientSnapshot } from './client-host.js';
import { readAudioRoutes, useAndroidAudioRoutes } from './android-audio-routes.js';
import { AndroidAudioSettings } from './android-audio-settings.js';
import { MeetingSettings, type MeetingControlsProps } from '../components/meeting-controls.js';
import { MeetingRoomPage } from '../pages/meeting-room-page.js';
import type { MeetingRoomController, MeetingRoomState } from '../meeting/room-controller.js';

const client = vi.hoisted(() => ({ snapshot: { joined: false, update: 'idle' } as ClientSnapshot }));
vi.mock('./client-host.js', () => ({
  useClientHost: () => client.snapshot, getClientHost: () => client.snapshot.host, getClientSnapshot: () => client.snapshot,
  acquireClientMeeting: () => () => undefined, setClientMicrophoneEnabled: vi.fn(), checkClientUpdate: vi.fn(),
}));
const initial: ClientAudioRoutes = {
  revision: 1, devices: [
    { id: 'default', label: 'System', type: 'default' }, { id: 'speaker', label: 'Speaker', type: 'speaker' },
    { id: 'earpiece', label: 'Earpiece', type: 'earpiece' }, { id: 'bluetooth', label: 'Connected headset', type: 'bluetooth' },
  ], selectedId: 'default', actualDeviceId: 'speaker', pendingId: null, bluetoothPermission: 'required', microphoneFollowsOutput: true, canSelect: true,
};
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness() {
  let state = structuredClone(initial);
  const listeners = new Set<(event: ClientHostEvent) => void>();
  const calls = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'audio.select') state = { ...state, revision: state.revision + 1, selectedId: String(params!.deviceId), actualDeviceId: String(params!.deviceId) };
    if (method === 'audio.bluetoothPermission') state = { ...state, revision: state.revision + 1, bluetoothPermission: 'granted' };
    return state;
  });
  const host: ClientHost = { platform: 'android', request: <T,>(method: Parameters<ClientHost['request']>[0], params?: Record<string, unknown>) => calls(method, params) as Promise<T>,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const emit = (next: ClientAudioRoutes) => { state = next; for (const listener of listeners) listener({ v: 1, event: 'audio.routesChanged', state }); };
  return { host, calls, emit, listeners };
}
const settings: MeetingControlsProps = { connection: 'connected', microphoneEnabled: false, audioPlaybackBlocked: false, devices: [], leaving: false,
  onMicrophoneToggle: vi.fn(), onMicrophoneDeviceChange: vi.fn(), onSpeakerDeviceChange: vi.fn(), onResumeAudio: vi.fn(), onLeave: vi.fn() };
beforeEach(() => { client.snapshot = { joined: false, update: 'idle' }; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('validates actual native route snapshots without trusting malformed state', () => {
  expect(readAudioRoutes(initial)).toEqual(initial);
  for (const value of [{ ...initial, revision: -1 }, { ...initial, canSelect: 'true' }, { ...initial, microphoneFollowsOutput: false },
    { ...initial, devices: [] }, { ...initial, devices: [initial.devices[0], initial.devices[0]] }, { ...initial, pendingId: 123 }]) expect(readAudioRoutes(value)).toBeUndefined();
});

it('only reads on mount and requires an explicit action for Bluetooth permission', async () => {
  const h = harness(); const hook = renderHook(() => useAndroidAudioRoutes(h.host, true, true));
  await waitFor(() => expect(hook.result.current?.state?.selectedId).toBe('default'));
  expect(h.calls.mock.calls.map(call => call[0])).toEqual(['audio.routes']);
  await act(async () => { await hook.result.current?.requestBluetoothPermission(); });
  expect(h.calls.mock.calls.map(call => call[0])).toEqual(['audio.routes', 'audio.bluetoothPermission']);
  expect(hook.result.current?.state?.bluetoothPermission).toBe('granted');
  expect(hook.result.current?.state?.selectedId).toBe('default');
});

it('accepts a later confirmed Bluetooth grant without switching a device automatically', async () => {
  const h = harness(); const hook = renderHook(() => useAndroidAudioRoutes(h.host, true, true));
  await waitFor(() => expect(hook.result.current?.state).toBeDefined());
  h.calls.mockRejectedValueOnce(new Error('permission response timed out'));
  await act(async () => { await hook.result.current!.requestBluetoothPermission(); });
  expect(hook.result.current?.error).toBe('permission');
  act(() => h.emit({ ...initial, revision: 3, bluetoothPermission: 'granted' }));
  expect(hook.result.current?.error).toBeUndefined(); expect(hook.result.current?.state?.selectedId).toBe('default');
  expect(h.calls.mock.calls.some(call => call[0] === 'audio.select')).toBe(false);
});

it('does not let a stale RPC overwrite a newer hardware-change event', async () => {
  const h = harness(), read = deferred<ClientAudioRoutes>(); h.calls.mockImplementationOnce(() => read.promise);
  const hook = renderHook(() => useAndroidAudioRoutes(h.host, true, true));
  const unplugged = { ...initial, revision: 4, devices: initial.devices.filter(device => device.type !== 'bluetooth'), actualDeviceId: 'earpiece' };
  act(() => h.emit(unplugged));
  await act(async () => { read.resolve(initial); });
  expect(hook.result.current?.state).toEqual(unplugged);
});

it('keeps the confirmed selection while switching, then accepts only the confirmed native route', async () => {
  const h = harness(); const hook = renderHook(() => useAndroidAudioRoutes(h.host, true, true));
  await waitFor(() => expect(hook.result.current?.state).toBeDefined());
  const selection = deferred<ClientAudioRoutes>(); h.calls.mockImplementationOnce(() => selection.promise);
  let switching!: Promise<void>;
  act(() => { switching = hook.result.current!.select('bluetooth'); h.emit({ ...initial, revision: 2, pendingId: 'bluetooth' }); });
  expect(hook.result.current?.state?.selectedId).toBe('default'); expect(hook.result.current?.operation).toBe('selecting');
  await act(async () => { selection.resolve({ ...initial, revision: 3, selectedId: 'bluetooth', actualDeviceId: 'bluetooth', pendingId: null }); await switching; });
  expect(hook.result.current?.state?.selectedId).toBe('bluetooth'); expect(hook.result.current?.operation).toBeUndefined();
});

it('refreshes the real fallback device after a rejected selection', async () => {
  const h = harness(); const hook = renderHook(() => useAndroidAudioRoutes(h.host, true, true));
  await waitFor(() => expect(hook.result.current?.state).toBeDefined());
  h.calls.mockRejectedValueOnce(new Error('device disconnected'));
  h.calls.mockResolvedValueOnce({ ...initial, revision: 3, devices: initial.devices.filter(device => device.type !== 'bluetooth'), actualDeviceId: 'earpiece' });
  await act(async () => { await hook.result.current!.select('bluetooth'); });
  expect(hook.result.current?.error).toBe('select'); expect(hook.result.current?.state?.selectedId).toBe('default');
  expect(hook.result.current?.state?.actualDeviceId).toBe('earpiece');
  expect(h.calls.mock.calls.map(call => call[0])).toEqual(['audio.routes', 'audio.select', 'audio.routes']);
});

it('drops a late selection response after leaving and joining a fresh session', async () => {
  const h = harness(); const hook = renderHook(({ active }) => useAndroidAudioRoutes(h.host, true, active), { initialProps: { active: true } });
  await waitFor(() => expect(hook.result.current?.state).toBeDefined());
  const old = deferred<ClientAudioRoutes>(); h.calls.mockImplementationOnce(() => old.promise);
  let selecting!: Promise<void>; act(() => { selecting = hook.result.current!.select('bluetooth'); });
  hook.rerender({ active: false }); expect(h.listeners.size).toBe(0);
  hook.rerender({ active: true }); await waitFor(() => expect(hook.result.current?.state?.selectedId).toBe('default'));
  await act(async () => { old.resolve({ ...initial, revision: 99, selectedId: 'bluetooth' }); await selecting; });
  expect(hook.result.current?.state?.selectedId).toBe('default');
});

it('shows legacy Android upgrade guidance and leaves desktop/browser controls alone', () => {
  const h = harness(); const hook = renderHook(() => useAndroidAudioRoutes(h.host, undefined, true));
  const ui = render(<MeetingSettings {...settings} section="audio" nativeAudio={hook.result.current} />);
  expect(screen.getByText(/Update the Android client to select speaker/)).toBeVisible();
  expect(screen.queryByLabelText('Microphone device')).not.toBeInTheDocument(); expect(h.calls).not.toHaveBeenCalled();
  ui.rerender(<MeetingSettings {...settings} section="audio" />);
  expect(screen.getByLabelText('Microphone device')).toBeVisible(); expect(screen.getByLabelText('Speaker device')).toBeVisible();
});

it('renders one paired route selector, actual device, busy state and explicit permission action', () => {
  const refresh = vi.fn(async () => {}), select = vi.fn(async () => {}), requestBluetoothPermission = vi.fn(async () => {});
  const props = { availability: 'supported' as const, active: true, state: initial, refresh, select, requestBluetoothPermission };
  const ui = render(<AndroidAudioSettings audio={props} />);
  expect(screen.getAllByRole('combobox')).toHaveLength(1);
  expect(screen.getByRole('status')).toHaveTextContent('Current call output: Speaker');
  fireEvent.change(screen.getByLabelText('Call audio device'), { target: { value: 'earpiece' } }); expect(select).toHaveBeenCalledWith('earpiece');
  expect(requestBluetoothPermission).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Allow Bluetooth devices' })); expect(requestBluetoothPermission).toHaveBeenCalledOnce();
  ui.rerender(<AndroidAudioSettings audio={{ ...props, operation: 'selecting', state: { ...initial, pendingId: 'bluetooth' } }} />);
  expect(screen.getByLabelText('Call audio device')).toBeDisabled(); expect(screen.getByLabelText('Call audio device')).toHaveValue('default');
  expect(screen.getByText('Switching the call audio device…')).toBeVisible();
});

it('wires real meeting controls to native routes without browser output or microphone device IDs', async () => {
  const h = harness();
  client.snapshot = { host: h.host, info: { protocol: 1, platform: 'android', appVersion: '0.1.4', screenCapture: true, audioRouting: true }, joined: true, update: 'current' };
  const state: MeetingRoomState = { connection: 'connected', participants: [], microphoneEnabled: false, audioPlaybackBlocked: false, screenShareAuthorized: false };
  const microphone = vi.fn(async () => {}), output = vi.fn(async () => 'changed' as const);
  const controller: MeetingRoomController = {
    connect: async () => {}, disconnect: async () => {}, setMicrophoneEnabled: microphone, switchAudioOutput: output,
    publishScreenShare: async () => {}, releaseScreenShare: async () => {}, setRemoteScreenShareSubscribed: async () => {},
    setCallAudioVolume: () => {}, resumeAudioPlayback: async () => {}, subscribe: listener => { listener(state); return () => {}; },
  };
  const join: JoinMeetingResponse = { participantIdentity: 'local', participantName: 'Local', livekitUrl: 'wss://rtc.example', token: 'test-token', meetingExpiresAt: 1_800_000_000_000, permissions: { publishSources: ['microphone'] } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
  render(<MeetingRoomPage slug="test-room" join={join} controller={controller} listDevices={async () => []} />);
  await waitFor(() => expect(h.calls).toHaveBeenCalledWith('audio.routes', undefined));
  const toolbar = screen.getByRole('toolbar', { name: 'Primary meeting controls' });
  fireEvent.click(within(toolbar).getByRole('button', { name: 'Audio and devices' }));
  fireEvent.change(await screen.findByLabelText('Call audio device'), { target: { value: 'speaker' } });
  await waitFor(() => expect(h.calls).toHaveBeenCalledWith('audio.select', { deviceId: 'speaker' }));
  expect(output).not.toHaveBeenCalled(); expect(microphone).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Microphone device')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Unmute microphone' }));
  expect(microphone).toHaveBeenCalledWith(true);
});
