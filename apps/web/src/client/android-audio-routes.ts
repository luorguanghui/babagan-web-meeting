import type { ClientAudioRoutes, ClientHostRequest } from '@meeting/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClientHostError, type ClientHost } from './host-bridge.js';

export interface AndroidAudioControls {
  availability: 'supported' | 'upgrade' | 'unavailable';
  active: boolean;
  state?: ClientAudioRoutes;
  operation?: 'loading' | 'selecting' | 'permission';
  error?: 'load' | 'select' | 'permission';
  refresh(): Promise<void>;
  select(deviceId: string): Promise<void>;
  requestBluetoothPermission(): Promise<void>;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;
const deviceTypes = new Set(['default', 'speaker', 'earpiece', 'bluetooth', 'wired', 'usb']);
const permissions = new Set(['not-required', 'required', 'granted', 'denied']);

/** Device names are only rendered locally; never persist or forward them to the meeting API. */
export function readAudioRoutes(value: unknown): ClientAudioRoutes | undefined {
  if (!record(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || !Array.isArray(value.devices) || value.devices.length < 1 || value.devices.length > 64
    || !id(value.selectedId) || !(value.requestedId === undefined || id(value.requestedId)) || !(value.actualDeviceId === null || id(value.actualDeviceId))
    || !(value.pendingId === null || id(value.pendingId)) || typeof value.bluetoothPermission !== 'string' || !permissions.has(value.bluetoothPermission)
    || value.microphoneFollowsOutput !== true || typeof value.canSelect !== 'boolean') return;
  const ids = new Set<string>();
  for (const device of value.devices) {
    if (!record(device) || !id(device.id) || ids.has(device.id) || typeof device.label !== 'string'
      || device.label.length > 200 || typeof device.type !== 'string' || !deviceTypes.has(device.type)) return;
    if ((device.type === 'default') !== (device.id === 'default')) return;
    ids.add(device.id);
  }
  if (!ids.has('default')) return;
  return value as unknown as ClientAudioRoutes;
}

export function useAndroidAudioRoutes(host: ClientHost | undefined, capability: boolean | undefined, active: boolean): AndroidAudioControls | undefined {
  const [state, setState] = useState<ClientAudioRoutes>();
  const [operation, setOperation] = useState<AndroidAudioControls['operation']>();
  const [error, setError] = useState<AndroidAudioControls['error']>();
  const generation = useRef(0), revision = useRef(-1), pending = useRef(false);
  const activeController = useRef<AbortController | undefined>(undefined);
  const available = host?.platform === 'android' && capability === true && active;
  const accept = useCallback((value: unknown) => {
    const next = readAudioRoutes(value);
    if (!next) throw new ClientHostError('protocol', 'Invalid native audio route response.');
    if (next.revision < revision.current) return;
    revision.current = next.revision; setState(next);
    if (next.bluetoothPermission === 'granted') setError(previous => previous === 'permission' ? undefined : previous);
  }, []);

  useEffect(() => {
    const epoch = ++generation.current;
    activeController.current?.abort(); pending.current = false; revision.current = -1;
    setState(undefined); setError(undefined); setOperation(undefined);
    if (!available || !host) return;
    const controller = new AbortController(); activeController.current = controller;
    pending.current = true; setOperation('loading');
    const detach = host.subscribe(event => {
      if (generation.current !== epoch || controller.signal.aborted || event.event !== 'audio.routesChanged') return;
      try { accept(event.state); } catch { /* A malformed event cannot overwrite the last confirmed route. */ }
    });
    void host.request('audio.routes', undefined, { signal: controller.signal }).then(value => {
      if (generation.current === epoch && !controller.signal.aborted) accept(value);
    }).catch(() => {
      if (generation.current === epoch && !controller.signal.aborted) setError('load');
    }).finally(() => {
      if (generation.current === epoch) { pending.current = false; setOperation(undefined); }
    });
    return () => { generation.current++; controller.abort(); activeController.current?.abort(); pending.current = false; detach(); };
  }, [host, available, accept]);

  const request = useCallback(async (method: ClientHostRequest['method'], params: Record<string, unknown> | undefined,
    kind: NonNullable<AndroidAudioControls['operation']>, failure: NonNullable<AndroidAudioControls['error']>) => {
    if (!available || !host || pending.current) return;
    const epoch = generation.current;
    const controller = new AbortController(); activeController.current = controller;
    pending.current = true; setOperation(kind); setError(undefined);
    try {
      const value = await host.request(method, params, { signal: controller.signal, timeoutMs: method === 'audio.bluetoothPermission' ? 60_000 : 20_000 });
      if (generation.current === epoch && !controller.signal.aborted) accept(value);
    } catch {
      if (generation.current !== epoch || controller.signal.aborted) return;
      setError(failure);
      // Refresh the actual device after rejection/disconnection; never claim that the requested route won.
      if (method !== 'audio.routes') try {
        const value = await host.request('audio.routes', undefined, { signal: controller.signal });
        if (generation.current === epoch && !controller.signal.aborted) accept(value);
      } catch { /* The explicit refresh action remains available after an error. */ }
    } finally {
      if (generation.current === epoch) { pending.current = false; setOperation(undefined); }
    }
  }, [available, host, accept]);
  const refresh = useCallback(() => request('audio.routes', undefined, 'loading', 'load'), [request]);
  const select = useCallback(async (deviceId: string) => {
    if (!state?.canSelect || state.pendingId !== null || !state.devices.some(device => device.id === deviceId)) return;
    await request('audio.select', { deviceId }, 'selecting', 'select');
  }, [request, state]);
  const requestBluetoothPermission = useCallback(() => request('audio.bluetoothPermission', undefined, 'permission', 'permission'), [request]);
  if (host?.platform !== 'android') return;
  return { availability: capability === true ? 'supported' : capability === undefined ? 'upgrade' : 'unavailable', active,
    state, operation, error, refresh, select, requestBluetoothPermission };
}
