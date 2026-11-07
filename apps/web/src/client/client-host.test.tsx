import { afterEach, expect, it, vi } from 'vitest';
import type { ClientHostRequest } from '@meeting/contracts';
import type { ClientHostWindow, NativeClientBridge } from './host-bridge.js';

const bridges: NativeClientBridge[] = [];
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); });
async function harness(infoUpdate?: unknown, checkedUpdate: unknown = { status: 'current' }) {
  vi.resetModules();
  const client = await import('./client-host.js');
  const calls: ClientHostRequest[] = [];
  const android = { onmessage: null as ((event: { data: string }) => void) | null, postMessage: (text: string) => {
    const request = JSON.parse(text) as ClientHostRequest; calls.push(request);
    const result = request.method === 'client.info' ? { platform: 'android', appVersion: '0.3.0', protocol: 1, screenCapture: true, systemAudio: false, updateState: infoUpdate }
      : request.method === 'update.check' ? checkedUpdate : {};
    queueMicrotask(() => android.onmessage?.({ data: JSON.stringify({ v: 1, id: request.id, ok: true, result }) }));
  } };
  const target = Object.assign(new EventTarget(), { BabaganAndroid: android }) as unknown as ClientHostWindow;
  const bridge = client.initializeClientHost(target) as NativeClientBridge; bridges.push(bridge);
  return { client, calls, target, android };
}

it('announces a real meeting once, without a false idle window during a StrictMode remount', async () => {
  const h = await harness(); const first = h.client.acquireClientMeeting(); first();
  const second = h.client.acquireClientMeeting(); await Promise.resolve();
  expect(h.calls.filter(call => call.method === 'meeting.state').map(call => call.params)).toEqual([{ joined: true }]);
  expect(h.client.getClientSnapshot().joined).toBe(true);
  second(); await Promise.resolve();
  expect(h.calls.filter(call => call.method === 'meeting.state').map(call => call.params)).toEqual([{ joined: true }, { joined: false }]);
});

it('defers manual update checks until no meeting is active and reads the host status', async () => {
  const h = await harness(); const leave = h.client.acquireClientMeeting();
  await h.client.checkClientUpdate(); expect(h.calls.some(call => call.method === 'update.check')).toBe(false);
  h.android.onmessage?.({ data: JSON.stringify({ v: 1, event: 'update.state', state: 'available' }) });
  expect(h.client.getClientSnapshot()).toMatchObject({ joined: true, update: 'available' });
  leave(); await Promise.resolve(); await h.client.checkClientUpdate();
  expect(h.client.getClientSnapshot()).toMatchObject({ joined: false, update: 'current', info: { platform: 'android', systemAudio: false } });
});

it('marks navigation idle and restores a retained meeting after back-forward cache restoration', async () => {
  const h = await harness(); const leave = h.client.acquireClientMeeting();
  h.target.dispatchEvent(new Event('pagehide')); expect(h.client.getClientSnapshot().joined).toBe(false);
  h.target.dispatchEvent(new Event('pageshow')); expect(h.client.getClientSnapshot().joined).toBe(true);
  leave(); await Promise.resolve(); expect(h.client.getClientSnapshot().joined).toBe(false);
  expect(h.calls.filter(call => call.method === 'meeting.state').map(call => call.params)).toEqual([{ joined: true }, { joined: false }, { joined: true }, { joined: false }]);
});

it('reports actual Android microphone changes and turns the foreground microphone off on leave', async () => {
  const h = await harness(); const leave = h.client.acquireClientMeeting();
  h.client.setClientMicrophoneEnabled(false); h.client.setClientMicrophoneEnabled(true); h.client.setClientMicrophoneEnabled(true);
  expect(h.calls.filter(call => call.method === 'microphone.state').map(call => call.params)).toEqual([{ enabled: false }, { enabled: true }]);
  h.target.dispatchEvent(new Event('pagehide')); h.target.dispatchEvent(new Event('pageshow'));
  leave(); await Promise.resolve();
  expect(h.calls.filter(call => call.method === 'microphone.state').map(call => call.params)).toEqual([{ enabled: false }, { enabled: true }, { enabled: false }, { enabled: true }, { enabled: false }]);
  expect(h.calls.filter(call => call.method === 'meeting.state').every(call => Object.keys(call.params ?? {}).join(',') === 'joined')).toBe(true);
});

it('never sends Android microphone methods to the Windows host', async () => {
  vi.resetModules(); const client = await import('./client-host.js'); const calls: ClientHostRequest[] = [];
  const target = Object.assign(new EventTarget(), { chrome: { webview: { postMessage: (value: ClientHostRequest) => calls.push(value), addEventListener: () => {}, removeEventListener: () => {} } } }) as unknown as ClientHostWindow;
  bridges.push(client.initializeClientHost(target) as NativeClientBridge);
  const leave = client.acquireClientMeeting(); client.setClientMicrophoneEnabled(true); leave(); await Promise.resolve();
  expect(calls.some(call => call.method === 'microphone.state')).toBe(false);
});

it('accepts Android deferred, downloaded and installing update states', async () => {
  const h = await harness();
  for (const [state, expected] of [['deferred', 'deferred'], ['downloaded', 'ready'], ['installing', 'installing']] as const) {
    h.android.onmessage?.({ data: JSON.stringify({ v: 1, event: 'update.state', state }) });
    expect(h.client.getClientSnapshot().update).toBe(expected);
  }
});

it('retains real bytes and verification phase from native update events', async () => {
  const h = await harness();
  h.android.onmessage?.({ data: JSON.stringify({ v: 1, event: 'update.state', state: 'downloading', phase: 'downloading', downloadedBytes: 25, totalBytes: 100, updateRevision: 1 }) });
  expect(h.client.getClientSnapshot()).toMatchObject({ update: 'downloading', updateProgress: { phase: 'downloading', downloadedBytes: 25, totalBytes: 100 } });
  h.android.onmessage?.({ data: JSON.stringify({ v: 1, event: 'update.state', state: 'downloading', phase: 'verifying', downloadedBytes: 100, totalBytes: 100, updateRevision: 2 }) });
  expect(h.client.getClientSnapshot().updateProgress?.phase).toBe('verifying');
});

it('restores native update progress on page reload and check responses', async () => {
  const h = await harness({ state: 'downloading', phase: 'downloading', downloadedBytes: 20, totalBytes: 100, updateRevision: 4 },
    { state: 'downloading', phase: 'downloading', downloadedBytes: 60, totalBytes: 100, updateRevision: 5 });
  await Promise.resolve();
  expect(h.client.getClientSnapshot()).toMatchObject({ update: 'downloading', updateProgress: { downloadedBytes: 20, totalBytes: 100 } });
  await h.client.checkClientUpdate();
  expect(h.client.getClientSnapshot()).toMatchObject({ update: 'downloading', updateProgress: { downloadedBytes: 60, totalBytes: 100 } });
});

it('discards queued progress after deferral and after a newer retry starts', async () => {
  const h = await harness();
  const emit = (value: object) => h.android.onmessage?.({ data: JSON.stringify({ v: 1, event: 'update.state', ...value }) });
  emit({ state: 'downloading', phase: 'downloading', downloadedBytes: 80, totalBytes: 100, updateRevision: 8 });
  emit({ state: 'deferred', updateRevision: 9 });
  emit({ state: 'downloading', phase: 'downloading', downloadedBytes: 90, totalBytes: 100, updateRevision: 8 });
  expect(h.client.getClientSnapshot()).toMatchObject({ update: 'deferred', updateProgress: undefined });
  emit({ state: 'downloading', phase: 'downloading', downloadedBytes: 0, totalBytes: 100, updateRevision: 10 });
  emit({ state: 'downloaded', updateRevision: 8 });
  expect(h.client.getClientSnapshot()).toMatchObject({ update: 'downloading', updateProgress: { downloadedBytes: 0 } });
  emit({ state: 'error', updateRevision: 11 });
  expect(h.client.getClientSnapshot().updateProgress).toBeUndefined();
});

it.each([
  [-1, 100], [101, 100], [10, 0], [10, -100], [0.5, 100], [1, Number.MAX_SAFE_INTEGER + 1], ['25', 100], [25, '100'], [null, 100],
])('never exposes malformed native byte totals (%s / %s)', async (downloadedBytes, totalBytes) => {
  const h = await harness();
  h.android.onmessage?.({ data: JSON.stringify({ v: 1, event: 'update.state', state: 'downloading', phase: 'downloading', downloadedBytes, totalBytes }) });
  expect(h.client.getClientSnapshot().update).toBe('downloading');
  expect(h.client.getClientSnapshot().updateProgress).toBeUndefined();
});

it('does not overwrite newer native progress with a stale info or check response', async () => {
  const h = await harness({ state: 'current', updateRevision: 1 }, { state: 'current', updateRevision: 1 });
  const check = h.client.checkClientUpdate();
  h.android.onmessage?.({ data: JSON.stringify({ v: 1, event: 'update.state', state: 'downloading', phase: 'downloading', downloadedBytes: 70, totalBytes: 100, updateRevision: 3 }) });
  await check;
  expect(h.client.getClientSnapshot()).toMatchObject({ update: 'downloading', updateProgress: { downloadedBytes: 70 } });
});
