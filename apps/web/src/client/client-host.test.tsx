import { afterEach, expect, it, vi } from 'vitest';
import type { ClientHostRequest } from '@meeting/contracts';
import type { ClientHostWindow, NativeClientBridge } from './host-bridge.js';

const bridges: NativeClientBridge[] = [];
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); });
async function harness() {
  vi.resetModules();
  const client = await import('./client-host.js');
  const calls: ClientHostRequest[] = [];
  const android = { onmessage: null as ((event: { data: string }) => void) | null, postMessage: (text: string) => {
    const request = JSON.parse(text) as ClientHostRequest; calls.push(request);
    const result = request.method === 'client.info' ? { platform: 'android', appVersion: '0.3.0', protocol: 1, screenCapture: true, systemAudio: false }
      : request.method === 'update.check' ? { status: 'current' } : {};
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
