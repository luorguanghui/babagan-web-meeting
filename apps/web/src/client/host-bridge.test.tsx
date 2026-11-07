import { afterEach, expect, it, vi } from 'vitest';
import type { ClientHostRequest } from '@meeting/contracts';
import { NativeClientBridge, detectClientTransport, validClientInfo, type ClientHostWindow } from './host-bridge.js';

const bridges: NativeClientBridge[] = [];
function harness() {
  const sent: ClientHostRequest[] = [];
  let receiver: (message: unknown) => void = () => {};
  const unlisten = vi.fn();
  const bridge = new NativeClientBridge({ platform: 'android', send: request => { sent.push(request); }, listen: listener => { receiver = listener; return unlisten; } });
  bridges.push(bridge);
  return { bridge, sent, unlisten, receive: (value: unknown) => receiver(value) };
}
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); vi.useRealTimers(); });

it('correlates replies and ignores unknown versions, request IDs, malformed responses and duplicate replies', async () => {
  const h = harness(); const result = h.bridge.request('client.info'); const settled = vi.fn(); void result.then(settled);
  const id = h.sent[0].id;
  for (const message of ['{', { v: 2, id, ok: true, result: 'wrong' }, { v: 1, id: 'other', ok: true }, { v: 1, id, ok: 'true' }, { v: 1, id, ok: false, error: {} }]) h.receive(message);
  await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
  h.receive(JSON.stringify({ v: 1, id, ok: true, result: { platform: 'android' } }));
  await expect(result).resolves.toEqual({ platform: 'android' });
  h.receive({ v: 1, id, ok: false, error: { code: 'late', message: 'late' } });
  expect(settled).toHaveBeenCalledOnce();
});

it('rejects host errors, timeout and abort, removing their pending requests', async () => {
  vi.useFakeTimers(); const h = harness();
  const failed = h.bridge.request('capture.start'); const error = expect(failed).rejects.toMatchObject({ code: 'permission-denied' });
  h.receive({ v: 1, id: h.sent[0].id, ok: false, error: { code: 'permission-denied', message: 'No permission' } }); await error;
  const timed = h.bridge.request('client.info', undefined, { timeoutMs: 50 }); const timeout = expect(timed).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(50); await timeout;
  const abort = new AbortController(); const pending = h.bridge.request('capture.start', {}, { signal: abort.signal });
  const aborted = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); abort.abort(); await aborted;
  h.receive({ v: 1, id: h.sent[2].id, ok: true, result: 'late' });
  expect(vi.getTimerCount()).toBe(0);
});

it('forwards only known v1 events and releases listeners on disposal', async () => {
  const h = harness(); const listener = vi.fn(); h.bridge.subscribe(listener);
  h.receive({ v: 2, event: 'capture.ended', sessionId: 'a' }); h.receive({ v: 1, event: 'unknown' });
  h.receive({ v: 1, event: 'capture.ended', sessionId: 'a' }); expect(listener).toHaveBeenCalledOnce();
  const pending = h.bridge.request('client.info'); const closed = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
  h.bridge.dispose(); await closed; expect(h.unlisten).toHaveBeenCalledOnce();
});

it('uses the actual injected host API, not a user-agent hint', () => {
  expect(detectClientTransport({} as ClientHostWindow)).toBeUndefined();
  const android = { postMessage: vi.fn(), onmessage: null as ((event: { data: string }) => void) | null };
  const transport = detectClientTransport({ BabaganAndroid: android } as unknown as ClientHostWindow)!;
  const listener = vi.fn(); const detach = transport.listen(listener);
  transport.send({ v: 1, id: 'a', method: 'client.info' });
  expect(android.postMessage).toHaveBeenCalledWith('{"v":1,"id":"a","method":"client.info"}');
  android.onmessage!({ data: '{"v":1}' }); expect(listener).toHaveBeenCalledWith('{"v":1}'); detach(); expect(android.onmessage).toBeNull();
  const webview = { postMessage: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  detectClientTransport({ chrome: { webview } } as unknown as ClientHostWindow)!.send({ v: 1, id: 'b', method: 'client.info' });
  expect(webview.postMessage).toHaveBeenCalledWith({ v: 1, id: 'b', method: 'client.info' });
});

it('validates host capabilities against the detected platform and protocol', () => {
  const info = { protocol: 1, platform: 'android', appVersion: '0.3.0', screenCapture: true, systemAudio: false };
  expect(validClientInfo(info, 'android')).toBe(true);
  expect(validClientInfo(info, 'windows')).toBe(false);
  expect(validClientInfo({ ...info, protocol: 2 }, 'android')).toBe(false);
  expect(validClientInfo({ ...info, screenCapture: 'yes' }, 'android')).toBe(false);
  expect(validClientInfo({ ...info, maxScreenFrameRate: 30 }, 'android')).toBe(true);
  expect(validClientInfo({ ...info, appVersion: '0.1.2', maxScreenFrameRate: 60 }, 'android')).toBe(true);
  for (const maxScreenFrameRate of [0, 15, 90, '60', null]) expect(validClientInfo({ ...info, maxScreenFrameRate }, 'android')).toBe(false);
});
