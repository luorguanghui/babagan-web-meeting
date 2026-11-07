import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientHostEvent } from '@meeting/contracts';
import type { ClientSnapshot } from './client-host.js';
import type { ClientHost, HostRequestOptions } from './host-bridge.js';
import { ClientHostError } from './host-bridge.js';
import { openAndroidPictureInPicture } from './android-picture-in-picture.js';
import { openScreenPictureInPicture } from '../components/screen-picture-in-picture.js';
import { ScreenStage } from '../components/screen-stage.js';

const client = vi.hoisted(() => ({ snapshot: { joined: true, update: 'current' } as ClientSnapshot }));
vi.mock('./client-host.js', () => ({ getClientSnapshot: () => client.snapshot, getClientHost: () => client.snapshot.host }));
const labels = { name: 'Test', sharing: 'Test is sharing', close: 'Close', returnToMeeting: 'Return to meeting', audio: 'Shared audio' };
const harnesses: ReturnType<typeof hostHarness>[] = [];
function hostHarness() {
  const listeners = new Set<(event: ClientHostEvent) => void>();
  let current = '';
  const emit = (active: boolean, sessionId = current, reason?: string) => {
    for (const listener of [...listeners]) listener({ v: 1, event: 'pictureInPicture.state', sessionId, active, reason });
  };
  const calls = vi.fn(async (method: string, params: Record<string, unknown> = {}, _options?: HostRequestOptions): Promise<unknown> => {
    if (_options?.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const sessionId = String(params.sessionId ?? '');
    if (method === 'pictureInPicture.enter') { current = sessionId; return { sessionId, active: true }; }
    if (method === 'pictureInPicture.exit') { emit(false, sessionId); return { sessionId, active: false, released: true }; }
    return { sessionId, active: true };
  });
  const host: ClientHost = {
    platform: 'android', request: <T,>(method: Parameters<ClientHost['request']>[0], params?: Record<string, unknown>, options?: HostRequestOptions) => calls(method, params, options) as Promise<T>,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { host, calls, emit, listeners, session: () => current };
}
function installHost(pictureInPicture: boolean | undefined = true) {
  const h = hostHarness(); harnesses.push(h);
  client.snapshot = { host: h.host, info: { platform: 'android', protocol: 1, appVersion: '0.1.4', screenCapture: true, pictureInPicture }, joined: true, update: 'current' };
  return h;
}
function media() {
  const root = document.createElement('div'); root.inert = false;
  const focus = document.createElement('button'); focus.textContent = 'Previous focus'; root.append(focus);
  const home = document.createElement('div'), mediaHost = document.createElement('div'); mediaHost.className = 'screen-stage-media';
  const video = document.createElement('video'), audio = document.createElement('audio');
  const source = {} as MediaStream; video.srcObject = source; audio.srcObject = source;
  mediaHost.append(video, audio); home.append(mediaHost); root.append(home); document.body.append(root); focus.focus();
  return { root, focus, home, mediaHost, video, audio, source };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { client.snapshot = { joined: false, update: 'idle' }; });
afterEach(async () => {
  await act(async () => { for (const h of harnesses) h.emit(false); });
  cleanup(); harnesses.splice(0); document.body.replaceChildren(); document.body.removeAttribute('style');
  for (const name of ['fullscreenElement', 'exitFullscreen']) Reflect.deleteProperty(document, name);
  vi.useRealTimers(); vi.restoreAllMocks();
});

it('moves the same video and audio into an isolated media-only surface and restores DOM/focus on system expansion', async () => {
  const h = installHost(), m = media(), closed = vi.fn();
  document.body.style.setProperty('overflow', 'clip', 'important');
  const session = await openAndroidPictureInPicture(h.host, { ...m, labels, onClose: closed });
  expect(session.kind).toBe('android');
  const overlay = document.querySelector('[data-babagan-android-pip]')!;
  expect(overlay.querySelector('video')).toBe(m.video); expect(overlay.querySelector('audio')).toBe(m.audio);
  expect(m.video.srcObject).toBe(m.source); expect(m.audio.srcObject).toBe(m.source);
  expect(m.root.inert).toBe(true); expect(m.root).toHaveAttribute('aria-hidden', 'true');
  expect(h.calls.mock.calls[0]?.[1]).toMatchObject({ width: 16, height: 9 });
  h.emit(false, 'another-session'); expect(overlay.isConnected).toBe(true);
  h.emit(false);
  expect(m.mediaHost.parentElement).toBe(m.home); expect(closed).toHaveBeenCalledOnce();
  expect(m.root.inert).toBe(false); expect(m.root).not.toHaveAttribute('aria-hidden');
  expect(document.body.style.overflow).toBe('clip'); expect(document.activeElement).toBe(m.focus);
  expect(document.querySelector('[data-babagan-android-pip]')).toBeNull(); expect(h.listeners.size).toBe(0);
});

it('exits DOM fullscreen before moving media or requesting Activity PiP and forwards real dimension changes', async () => {
  const h = installHost(), m = media(), exited = deferred<void>();
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: m.home });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: vi.fn(() => exited.promise) });
  const opening = openAndroidPictureInPicture(h.host, { ...m, labels, onClose: vi.fn() });
  expect(h.calls).not.toHaveBeenCalled(); expect(m.mediaHost.parentElement).toBe(m.home);
  Object.defineProperty(m.video, 'videoWidth', { configurable: true, value: 1920 });
  Object.defineProperty(m.video, 'videoHeight', { configurable: true, value: 1080 });
  exited.resolve(); await opening;
  expect(h.calls.mock.calls[0]?.[1]).toMatchObject({ width: 1920, height: 1080 });
  Object.defineProperty(m.video, 'videoWidth', { configurable: true, value: 1080 });
  Object.defineProperty(m.video, 'videoHeight', { configurable: true, value: 1920 });
  fireEvent(m.video, new Event('resize'));
  expect(h.calls).toHaveBeenLastCalledWith('pictureInPicture.update', { sessionId: h.session(), width: 1080, height: 1920 }, undefined);
});

it('restores media synchronously during discard and releases native PiP without pulling the user to the foreground', async () => {
  const h = installHost(), m = media(), closed = vi.fn();
  const session = await openAndroidPictureInPicture(h.host, { ...m, labels, onClose: closed });
  const exit = deferred<unknown>(); h.calls.mockImplementationOnce(async () => exit.promise);
  const closing = session.close({ returnToMeeting: false });
  expect(m.mediaHost.parentElement).toBe(m.home);
  expect(document.querySelector('[data-babagan-android-pip] video')).toBeNull();
  expect(h.calls).toHaveBeenLastCalledWith('pictureInPicture.exit', { sessionId: h.session(), returnToMeeting: false }, { timeoutMs: 10000 });
  exit.resolve({ sessionId: h.session(), active: true, released: true }); await closing;
  expect(document.querySelector('[data-babagan-android-pip]')).toBeNull(); expect(closed).toHaveBeenCalledOnce();
});

it('waits for actual native expansion on explicit return and keeps media intact if return is rejected', async () => {
  const h = installHost(), m = media();
  const session = await openAndroidPictureInPicture(h.host, { ...m, labels, onClose: vi.fn() });
  h.calls.mockRejectedValueOnce(new ClientHostError('denied', 'blocked'));
  await expect(session.close({ returnToMeeting: true })).rejects.toMatchObject({ code: 'denied' });
  expect(document.querySelector('[data-babagan-android-pip] video')).toBe(m.video);
  h.calls.mockResolvedValueOnce({ sessionId: h.session(), active: true, released: false });
  let finished = false; const closing = Promise.resolve(session.close({ returnToMeeting: true })).then(() => { finished = true; });
  await Promise.resolve(); await Promise.resolve(); expect(finished).toBe(false);
  h.emit(false); await closing; expect(finished).toBe(true); expect(m.mediaHost.parentElement).toBe(m.home);
});

it('does not resurrect a session if Android closes it before the enter response arrives', async () => {
  const h = installHost(), m = media(), entering = deferred<unknown>(), closed = vi.fn();
  h.calls.mockImplementationOnce(async (_method, params = {}) => { h.emit(false, String(params.sessionId)); return entering.promise; });
  const opening = openAndroidPictureInPicture(h.host, { ...m, labels, onClose: closed });
  const rejection = expect(opening).rejects.toMatchObject({ name: 'AbortError' });
  const id = h.calls.mock.calls[0]![1]!.sessionId;
  entering.resolve({ sessionId: id, active: true }); await rejection;
  expect(closed).toHaveBeenCalledOnce(); expect(m.mediaHost.parentElement).toBe(m.home);
  expect(document.querySelector('[data-babagan-android-pip]')).toBeNull();
});

it('compensates a cancelled pending enter and never leaves moved React media behind', async () => {
  const h = installHost(), m = media(), entering = deferred<unknown>(), abort = new AbortController();
  h.calls.mockImplementationOnce(async () => entering.promise);
  const opening = openAndroidPictureInPicture(h.host, { ...m, labels, onClose: vi.fn(), signal: abort.signal });
  const rejection = expect(opening).rejects.toMatchObject({ name: 'AbortError' });
  const id = h.calls.mock.calls[0]![1]!.sessionId;
  abort.abort(); expect(m.mediaHost.parentElement).toBe(m.home);
  expect(h.calls).toHaveBeenLastCalledWith('pictureInPicture.exit', { sessionId: id, returnToMeeting: false }, { timeoutMs: 10000 });
  entering.resolve({ sessionId: id, active: true }); await rejection;
  expect(document.querySelector('[data-babagan-android-pip]')).toBeNull();
});

it('restores the page on native denial without trying a browser API to bypass the denial', async () => {
  const h = installHost(), m = media();
  const browserPip = vi.fn(); Object.defineProperty(m.video, 'requestPictureInPicture', { value: browserPip });
  h.calls.mockRejectedValueOnce(new ClientHostError('denied', 'blocked'));
  await expect(openScreenPictureInPicture({ ...m, labels, onClose: vi.fn() })).rejects.toMatchObject({ reason: 'denied' });
  expect(browserPip).not.toHaveBeenCalled(); expect(m.mediaHost.parentElement).toBe(m.home); expect(m.root.inert).toBe(false);
});

it('gives an upgrade message for older Android hosts and a device message for unsupported new hosts', async () => {
  installHost(); delete client.snapshot.info!.pictureInPicture;
  const ui = render(<ScreenStage stream={{} as MediaStream} pipAllowed />);
  fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Update the Android client');
  ui.unmount(); installHost(false);
  render(<ScreenStage stream={{} as MediaStream} pipAllowed />);
  fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
  expect(await screen.findByRole('status')).toHaveTextContent('This Android device');
});

it('keeps the original media/audio and a hidden handover probe while switching sources in native PiP', async () => {
  const h = installHost(), first = {} as MediaStream, next = {} as MediaStream;
  const ui = render(<ScreenStage stream={first} pipAllowed muted={false} independentAudio />);
  const video = ui.container.querySelector('video')!, audio = ui.container.querySelector('audio')!;
  fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
  await waitFor(() => expect(ui.container.querySelector('.screen-stage')).toHaveAttribute('data-pip', 'android'));
  ui.rerender(<ScreenStage stream={next} pipAllowed muted={false} independentAudio />);
  const overlay = document.querySelector('[data-babagan-android-pip]')!;
  const probe = overlay.querySelector('video[data-stage-probe]')! as HTMLVideoElement;
  expect(probe.hidden).toBe(true); expect(getComputedStyle(probe).display).toBe('none');
  expect(overlay.querySelector('video:not([data-stage-probe])')).toBe(video); expect(overlay.querySelector('audio')).toBe(audio);
  fireEvent.loadedMetadata(probe);
  expect(video.srcObject).toBe(next); expect(overlay.querySelector('audio')).toBe(audio);
  await act(async () => { h.emit(false); });
  expect(ui.container.querySelector('video')).toBe(video); expect(ui.container.querySelector('audio')).toBe(audio);
});

it('handles share-end unmount during pending Android entry without a stale pressed button or DOM removal error', async () => {
  const h = installHost(), entering = deferred<unknown>(); h.calls.mockImplementationOnce(async () => entering.promise);
  const ui = render(<ScreenStage stream={{} as MediaStream} pipAllowed />);
  fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
  const id = h.calls.mock.calls[0]![1]!.sessionId;
  expect(() => ui.unmount()).not.toThrow();
  await act(async () => { entering.resolve({ sessionId: id, active: true }); });
  expect(document.querySelector('[data-babagan-android-pip]')).toBeNull(); expect(document.querySelector('video')).toBeNull();
});

it('retains adaptive-stream visibility while entry is pending and while its transport is handed over', async () => {
  const h = installHost(), entering = deferred<unknown>();
  h.calls.mockImplementationOnce(async () => entering.promise);
  type Info = { visible: boolean; pictureInPicture: boolean; width(): number; observe(): void; stopObserving(): void };
  const observed = new Set<Info>(); const media = {} as MediaStream;
  const track = {
    isAdaptiveStream: true,
    attach: vi.fn((element: HTMLMediaElement) => { element.srcObject = media; return element; }),
    detach: vi.fn((element: HTMLMediaElement) => element),
    observeElementInfo(info: Info) { observed.add(info); info.observe(); },
    stopObservingElementInfo(info: Info) { observed.delete(info); info.stopObserving(); },
  };
  const ui = render(<ScreenStage track={track} shareIdentity="one" pipAllowed />);
  const video = ui.container.querySelector('video')!;
  fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
  expect([...observed].some(info => info.visible && info.pictureInPicture && info.width() > 0)).toBe(true);
  const id = h.calls.mock.calls[0]![1]!.sessionId;
  await act(async () => { entering.resolve({ sessionId: id, active: true }); });
  expect(track.attach).toHaveBeenCalledOnce();
  const next = {} as MediaStream;
  ui.rerender(<ScreenStage stream={next} shareIdentity="one" pipAllowed />);
  expect(observed.size).toBe(1);
  fireEvent.loadedMetadata(document.querySelector('video[data-stage-probe]')!);
  expect(video.srcObject).toBe(next); expect(observed.size).toBe(0);
  await act(async () => { h.emit(false, String(id)); });
  expect(ui.container.querySelector('video')).toBe(video);
});

it('does not set the stage back to PiP when a system close overtakes the enter response', async () => {
  const h = installHost(), entering = deferred<unknown>(); h.calls.mockImplementationOnce(async () => entering.promise);
  const ui = render(<ScreenStage stream={{} as MediaStream} pipAllowed />);
  fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
  const id = String(h.calls.mock.calls[0]![1]!.sessionId);
  await act(async () => { h.emit(false, id); entering.resolve({ sessionId: id, active: true }); });
  expect(ui.container.querySelector('.screen-stage')).not.toHaveAttribute('data-pip');
  expect(screen.getByRole('button', { name: 'Picture in picture' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('shows the native rejection even when its enter-failed cleanup event arrives before the error response', async () => {
  const h = installHost();
  h.calls.mockImplementationOnce(async (_method, params = {}) => {
    h.emit(false, String(params.sessionId), 'enter-failed');
    throw new ClientHostError('denied', 'blocked');
  });
  render(<ScreenStage stream={{} as MediaStream} pipAllowed />);
  fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Android did not allow picture in picture');
  expect(document.querySelector('[data-babagan-android-pip]')).toBeNull();
});

it('keeps a direct native denial visible after the delayed compensating exit acknowledgement', async () => {
  const h = installHost(), exited = deferred<unknown>();
  h.calls.mockRejectedValueOnce(new ClientHostError('denied', 'blocked'));
  h.calls.mockImplementationOnce(async () => exited.promise);
  render(<ScreenStage stream={{} as MediaStream} pipAllowed />);
  fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Android did not allow picture in picture');
  const id = String(h.calls.mock.calls[0]![1]!.sessionId);
  await act(async () => { exited.resolve({ sessionId: id, active: false, released: true }); });
  expect(screen.getByRole('status')).toHaveTextContent('Android did not allow picture in picture');
  expect(screen.getByRole('button', { name: 'Picture in picture' })).toHaveAttribute('aria-pressed', 'false');
});
