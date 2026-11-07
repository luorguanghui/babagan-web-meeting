import type { ClientHostInfo } from '@meeting/contracts';
import { useSyncExternalStore } from 'react';

import { NativeClientBridge, detectClientTransport, validClientInfo, type ClientHost, type ClientHostWindow } from './host-bridge.js';

export type UpdateState = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'deferred' | 'installing' | 'ready' | 'error';
export interface ClientSnapshot { host?: ClientHost; info?: ClientHostInfo; joined: boolean; update: UpdateState; }
let snapshot: ClientSnapshot = { joined: false, update: 'idle' };
const listeners = new Set<() => void>();
let meetingLeases = 0;
let desiredMicrophoneEnabled = false;
let sentMicrophoneEnabled: boolean | undefined;
const updateStates = new Set<UpdateState>(['idle', 'checking', 'current', 'available', 'downloading', 'deferred', 'installing', 'ready', 'error']);
function normalizeUpdate(value: unknown): UpdateState | undefined { return value === 'downloaded' ? 'ready' : typeof value === 'string' && updateStates.has(value as UpdateState) ? value as UpdateState : undefined; }
function change(value: Partial<ClientSnapshot>): void { snapshot = { ...snapshot, ...value }; for (const listener of listeners) listener(); }
export function getClientSnapshot(): ClientSnapshot { return snapshot; }
export function getClientHost(): ClientHost | undefined { return snapshot.host; }
export function useClientHost(): ClientSnapshot { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getClientSnapshot, getClientSnapshot); }

export function initializeClientHost(target: ClientHostWindow = window): ClientHost | undefined {
  if (snapshot.host) return snapshot.host;
  const transport = detectClientTransport(target);
  if (!transport) return;
  const host = new NativeClientBridge(transport);
  change({ host });
  host.subscribe(event => { const update = normalizeUpdate(event.state); if (event.event === 'update.state' && update) change({ update }); });
  void host.request('client.info').then(info => {
    if (!validClientInfo(info, host.platform)) return;
    const initialUpdate = normalizeUpdate((info as ClientHostInfo & { updateState?: unknown }).updateState);
    change({ info, ...(initialUpdate ? { update: initialUpdate } : {}) });
  }).catch(() => undefined);
  target.addEventListener('pagehide', () => {
    if (snapshot.joined) { sendMicrophoneState(false); change({ joined: false }); void host.request('meeting.state', { joined: false }).catch(() => undefined); }
  });
  target.addEventListener('pageshow', () => {
    if (meetingLeases && !snapshot.joined) { change({ joined: true }); void host.request('meeting.state', { joined: true }).catch(() => undefined); sendMicrophoneState(desiredMicrophoneEnabled); }
  });
  return host;
}

/** StrictMode re-mounts cancel the deferred release; the host never sees a false idle window. */
export function acquireClientMeeting(): () => void {
  const host = getClientHost();
  if (!host) return () => undefined;
  meetingLeases++;
  if (!snapshot.joined) { change({ joined: true }); void host.request('meeting.state', { joined: true }).catch(() => undefined); }
  let released = false;
  return () => {
    if (released) return;
    released = true; meetingLeases = Math.max(0, meetingLeases - 1);
    queueMicrotask(() => {
      if (meetingLeases || !snapshot.joined) return;
      desiredMicrophoneEnabled = false; sendMicrophoneState(false);
      change({ joined: false }); void host.request('meeting.state', { joined: false }).catch(() => undefined);
    });
  };
}

function sendMicrophoneState(enabled: boolean): void {
  const host = getClientHost();
  if (host?.platform !== 'android' || sentMicrophoneEnabled === enabled) return;
  sentMicrophoneEnabled = enabled;
  void host.request('microphone.state', { enabled }).catch(() => { if (sentMicrophoneEnabled === enabled) sentMicrophoneEnabled = undefined; });
}
/** Reflects the microphone that the room controller actually enabled, never a permission request. */
export function setClientMicrophoneEnabled(enabled: boolean): void {
  desiredMicrophoneEnabled = enabled;
  sendMicrophoneState(enabled && snapshot.joined);
}

export async function checkClientUpdate(): Promise<void> {
  const host = getClientHost(); if (!host) return;
  if (snapshot.joined) return;
  change({ update: 'checking' });
  try {
    const result = await host.request('update.check', undefined, { timeoutMs: 60_000 });
    const status = result && typeof result === 'object' ? (result as { status?: unknown; state?: unknown }).status ?? (result as { state?: unknown }).state : undefined;
    const update = normalizeUpdate(status); if (update) change({ update });
  }
  catch { if (snapshot.update === 'checking') change({ update: 'error' }); }
}
