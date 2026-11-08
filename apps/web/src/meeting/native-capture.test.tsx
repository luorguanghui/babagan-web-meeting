import { afterEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_CAPTURE_PACKET_MAGIC } from '@meeting/contracts';
import { initializeNativeCaptureConnection, readNativeCaptureConnection, openNativeVideoTrack, captureNativeScreen, getNativePacingStats } from './native-capture.js';
import { beginNativeDiagnostics, getNativeDiagnosticSnapshot } from './native-diagnostics.js';
import { createScreenShareController } from './screen-share.js';

const token = 'a'.repeat(43);
const connection = { port: 25191, token };
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('native helper capability handoff', () => {
  it('consumes only a validated fragment and removes the capability from the visible URL', () => {
    const replace = vi.fn();
    initializeNativeCaptureConnection({ href: `https://meet.babagan.cloud/room?x=1#nativeCapture=1.25191.${token}&anchor=notes`, storage: sessionStorage, replace });
    expect(readNativeCaptureConnection(sessionStorage)).toEqual(connection);
    expect(replace).toHaveBeenCalledWith('/room?x=1#anchor=notes');
    expect(sessionStorage.getItem('babagan.native-capture')).not.toContain('https:');
  });
  it.each(['1.80.short', `1.70000.${token}`, `2.25191.${token}`, `1.25191.${token}@evil.test`])('rejects malformed handoff %s', fragment => {
    initializeNativeCaptureConnection({ href: `https://meet.babagan.cloud/#nativeCapture=${fragment}`, storage: sessionStorage, replace: vi.fn() });
    expect(readNativeCaptureConnection(sessionStorage)).toBeUndefined();
  });
});

class Socket extends EventTarget {
  binaryType = ''; readyState = 0; send = vi.fn(); close = vi.fn(() => { this.readyState = 3; });
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
class FakeVideoFrame {
  readonly close = vi.fn();
  constructor(readonly timestamp: number) {}
  clone() { return new FakeVideoFrame(this.timestamp); }
}
function nativeHarness() {
  const socket = new Socket();
  const stop = vi.fn();
  const track = Object.assign(new EventTarget(), { stop, kind: 'video', readyState: 'live',
    applyConstraints: vi.fn(async () => {}), getSettings: () => ({ width: 4, height: 2 }) });
  const writes: Array<{ timestamp: number; close: () => void }> = [];
  const writer = { write: vi.fn(async (frame: { timestamp: number; close: () => void }) => { writes.push(frame); }), close: vi.fn(async () => {}) };
  const createSocket = vi.fn(() => socket as unknown as WebSocket);
  const frames: Array<{ timestamp: number; close: ReturnType<typeof vi.fn> }> = [];
  const createFrame = vi.fn((_bytes: Uint8Array, init: VideoFrameBufferInit) => {
    const frame = new FakeVideoFrame(init.timestamp); frames.push(frame); return frame as unknown as VideoFrame;
  });
  return { socket, track, stop, writer, writes, frames, createSocket, createFrame,
    deps: { createSocket, createFrame, createTrackWriter: () => ({ track: track as unknown as MediaStreamTrack, writer }), timeOrigin: 1_000_000 } };
}
function packet(sequence: number, timestamp = 1_000_001_000) {
  const data = new ArrayBuffer(16 + 12);
  const view = new DataView(data); view.setUint32(0, NATIVE_CAPTURE_PACKET_MAGIC); view.setUint32(4, sequence); view.setFloat64(8, timestamp);
  return data;
}
const format = JSON.stringify({ type: 'format', format: 'I420', width: 4, height: 2, frameRate: 60 });

function httpStream(parts: Uint8Array[]) {
  const cancel = vi.fn(); let index = 0;
  const stream = new ReadableStream({ type: 'bytes', pull(controller: ReadableByteStreamController) {
    if (index < parts.length) controller.enqueue(parts[index++].slice());
  }, cancel });
  return { response: new Response(stream), cancel };
}
describe('native HTTP frame channel', () => {
  it('invokes the browser fetch with its Window receiver', async () => {
    const encoded = new TextEncoder().encode(format); const bytes = new Uint8Array(4 + encoded.length + 28);
    new DataView(bytes.buffer).setUint32(0, encoded.length); bytes.set(encoded, 4); bytes.set(new Uint8Array(packet(1)), 4 + encoded.length);
    const source = httpStream([bytes]); const h = nativeHarness();
    const fetch = vi.fn(function(this: unknown) { expect(this).toBe(globalThis); return Promise.resolve(source.response); });
    vi.stubGlobal('fetch', fetch);
    const track = await openNativeVideoTrack(connection, 60, { ...h.deps, createSocket: undefined });
    track.stop(); expect(fetch).toHaveBeenCalledOnce();
  });
  it('authenticates a bounded streaming POST and assembles fragmented frames without losing their timestamps', async () => {
    const encoded = new TextEncoder().encode(format); const bytes = new Uint8Array(4 + encoded.length + 28);
    new DataView(bytes.buffer).setUint32(0, encoded.length); bytes.set(encoded, 4); bytes.set(new Uint8Array(packet(1)), 4 + encoded.length);
    const source = httpStream(Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => bytes.slice(i * 7, i * 7 + 7)));
    const h = nativeHarness(); const request = vi.fn(async () => source.response);
    const track = await openNativeVideoTrack(connection, 60, { ...h.deps, createSocket: undefined, fetch: request });
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:25191/frames-http', expect.objectContaining({
      method: 'POST', credentials: 'omit', body: '{"frameRate":60}',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    }));
    expect(h.writes[0].timestamp).toBe(1000); track.stop();
    expect(source.cancel).toHaveBeenCalledOnce();
  });
  it('rejects oversized metadata before allocating a frame buffer', async () => {
    const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, 0xffffffff);
    const source = httpStream([prefix]); const h = nativeHarness();
    await expect(openNativeVideoTrack(connection, 60, { ...h.deps, createSocket: undefined, fetch: async () => source.response })).rejects.toBeInstanceOf(Error);
    expect(h.createFrame).not.toHaveBeenCalled(); expect(source.cancel).toHaveBeenCalledOnce();
  });
  it('reports unsupported source instead of telling the user to change network permissions', async () => {
    const h = nativeHarness();
    await expect(openNativeVideoTrack(connection, 60, { ...h.deps, createSocket: undefined, fetch: async () => new Response(null, { status: 422 }) }))
      .rejects.toMatchObject({ code: 'unsupported-source' });
  });
});

describe('native video track lifetime', () => {
  it('transfers the generator writable and waits for worker delivery before becoming ready', async () => {
    const h = nativeHarness(), worker = new FakeFrameWorker();
    const writable = { getWriter: vi.fn(() => h.writer) };
    vi.stubGlobal('crossOriginIsolated', true); vi.stubGlobal('Worker', function () { return worker; });
    vi.stubGlobal('MediaStreamTrackGenerator', function () { return Object.assign(h.track, { writable }); });
    let ready = false;
    const pending = openNativeVideoTrack(connection, 60, { ...h.deps, createTrackWriter: undefined }).then(track => { ready = true; return track; });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init', writable, frameRate: 60 }), [writable]));
    worker.message({ type: 'ready' });
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalledOnce());
    h.socket.open(); h.socket.message(format); h.socket.message(packet(1));
    const sent = worker.postMessage.mock.calls.find(([message]) => message.type === 'frame')![0];
    worker.message({ type: 'ack', id: sent.id, stats: { queuedFrames: 1, submittedFrames: 0, droppedFrames: 0 } });
    await Promise.resolve(); expect(ready).toBe(false); expect(writable.getWriter).not.toHaveBeenCalled();
    worker.message({ type: 'delivered', stats: { queuedFrames: 0, submittedFrames: 1, droppedFrames: 0 } });
    const track = await pending;
    expect(getNativePacingStats(track)).toMatchObject({ mode: 'worker', submittedFrames: 1 });
    track.stop(); worker.message({ type: 'stopped' });
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(h.stop).toHaveBeenCalledOnce();
  });

  it('falls back to a fresh local generator if worker initialization fails after transfer', async () => {
    const h = nativeHarness(), worker = new FakeFrameWorker(), abandonedStop = vi.fn();
    const abandoned = Object.assign(new EventTarget(), { stop: abandonedStop, writable: { getWriter: vi.fn() } });
    const createGenerator = vi.fn().mockReturnValueOnce(abandoned).mockReturnValueOnce(Object.assign(h.track, { writable: { getWriter: () => h.writer } }));
    vi.stubGlobal('crossOriginIsolated', true); vi.stubGlobal('Worker', function () { return worker; });
    vi.stubGlobal('MediaStreamTrackGenerator', function () { return createGenerator(); });
    const pending = openNativeVideoTrack(connection, 60, { ...h.deps, createTrackWriter: undefined });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    worker.message({ type: 'error', message: 'cannot acquire transferred writer' });
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalledOnce());
    h.socket.open(); h.socket.message(format); h.socket.message(packet(1)); const track = await pending;
    expect(abandonedStop).toHaveBeenCalledOnce(); expect(createGenerator).toHaveBeenCalledTimes(2);
    expect(getNativePacingStats(track)).toMatchObject({ mode: 'local', fallbackReason: expect.stringContaining('cannot acquire') });
    track.stop(); worker.message({ type: 'stopped' });
  });

  it('aborts worker startup before opening native capture and never creates a fallback after cancellation', async () => {
    vi.useFakeTimers(); const h = nativeHarness(), worker = new FakeFrameWorker(), abort = new AbortController();
    const writable = { getWriter: vi.fn(() => h.writer) };
    const createGenerator = vi.fn(() => Object.assign(h.track, { writable }));
    vi.stubGlobal('crossOriginIsolated', true); vi.stubGlobal('Worker', function () { return worker; });
    vi.stubGlobal('MediaStreamTrackGenerator', function () { return createGenerator(); });
    const pending = openNativeVideoTrack(connection, 60, { ...h.deps, createTrackWriter: undefined, signal: abort.signal }).catch(error => error);
    expect(worker.postMessage).toHaveBeenCalled(); abort.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    worker.message({ type: 'ready' }); await vi.advanceTimersByTimeAsync(250);
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(createGenerator).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledOnce(); expect(h.createSocket).not.toHaveBeenCalled(); expect(writable.getWriter).not.toHaveBeenCalled();
  });

  it('uses explicit local fallback when shared memory is not isolated', async () => {
    const h = nativeHarness(); const createWorker = vi.fn();
    vi.stubGlobal('crossOriginIsolated', false); vi.stubGlobal('Worker', createWorker);
    vi.stubGlobal('MediaStreamTrackGenerator', function () { return Object.assign(h.track, { writable: { getWriter: () => h.writer } }); });
    const pending = openNativeVideoTrack(connection, 60, { ...h.deps, createTrackWriter: undefined });
    h.socket.open(); h.socket.message(format); h.socket.message(packet(1)); const track = await pending;
    expect(createWorker).not.toHaveBeenCalled();
    expect(getNativePacingStats(track)).toMatchObject({ mode: 'local', scheduler: 'timer', fallbackReason: expect.stringContaining('unavailable') });
    track.stop(); expect(h.writer.close).toHaveBeenCalledOnce();
  });

  it('does not impose browser minimum-frame refresh on native source frames', async () => {
    const h = nativeHarness(); const pending = openNativeVideoTrack(connection, 60, h.deps);
    h.socket.open(); h.socket.message(format); h.socket.message(packet(1)); const track = await pending;
    const stream = { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] } as unknown as MediaStream;
    const controller = createScreenShareController({ requestGrant: async () => {}, releaseGrant: async () => {},
      getDisplayMedia: async () => stream, publisher: { publish: async () => {}, release: async () => {} } });
    await controller.start('h264', 20_000_000, 'motion');
    expect(h.track.applyConstraints).not.toHaveBeenCalledWith(expect.objectContaining({ frameRate: expect.anything() }));
    await controller.stop();
  });
  it('authenticates loopback, waits for a real frame, and stops capture when the track is stopped', async () => {
    const h = nativeHarness();
    let ready = false;
    const pending = openNativeVideoTrack(connection, 60, h.deps).then(track => { ready = true; return track; });
    expect(h.createSocket).toHaveBeenCalledWith('ws://127.0.0.1:25191/frames', ['babagan-native-v1', `auth.${token}`]);
    h.socket.open(); expect(h.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'start', frameRate: 60 }));
    h.socket.message(format); await Promise.resolve(); expect(ready).toBe(false);
    h.socket.message(packet(1)); const track = await pending;
    expect(h.writes[0].timestamp).toBe(1000);
    expect(h.frames[0].close).toHaveBeenCalledOnce();
    track.stop(); track.stop();
    expect(h.socket.close).toHaveBeenCalledOnce();
    expect(h.writer.close).toHaveBeenCalledOnce();
  });
  it('rejects invalid dimensions before creating frames', async () => {
    const h = nativeHarness();
    const pending = openNativeVideoTrack(connection, 60, h.deps).catch(error => error);
    h.socket.open(); h.socket.message(JSON.stringify({ type: 'format', format: 'I420', width: 999999, height: 1080, frameRate: 60 }));
    expect(await pending).toBeInstanceOf(Error); expect(h.createFrame).not.toHaveBeenCalled(); expect(h.socket.close).toHaveBeenCalledOnce();
  });
  it('rejects malformed payloads and stale timestamps instead of publishing corrupt frames', async () => {
    const h = nativeHarness(); const pending = openNativeVideoTrack(connection, 60, h.deps).catch(error => error);
    h.socket.open(); h.socket.message(format); h.socket.message(new ArrayBuffer(20));
    expect(await pending).toBeInstanceOf(Error); expect(h.createFrame).not.toHaveBeenCalled();
  });
  it('releases resources when helper startup times out', async () => {
    vi.useFakeTimers(); const h = nativeHarness(); const pending = openNativeVideoTrack(connection, 60, h.deps).catch(error => error);
    h.socket.open(); await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBeInstanceOf(Error); expect(h.socket.close).toHaveBeenCalledOnce(); expect(h.stop).toHaveBeenCalledOnce();
  });
  it('signals ended if the helper disconnects during publication', async () => {
    const h = nativeHarness(); const pending = openNativeVideoTrack(connection, 60, h.deps);
    h.socket.open(); h.socket.message(format); h.socket.message(packet(1)); const track = await pending;
    const ended = vi.fn(); track.addEventListener('ended', ended); h.socket.dispatchEvent(new Event('close'));
    expect(ended).toHaveBeenCalledOnce(); expect(h.stop).toHaveBeenCalledOnce();
  });
});

class FakeFrameWorker extends EventTarget {
  postMessage = vi.fn<(message: { type: string; id?: number; [key: string]: unknown }, transfers?: unknown[]) => void>();
  terminate = vi.fn();
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
}

describe('native source selection', () => {
  it('replaces only a verified primary screen video and preserves selected computer audio', async () => {
    const video = Object.assign(new EventTarget(), { kind: 'video', stop: vi.fn(), getSettings: () => ({ displaySurface: 'monitor', deviceId: 'screen:0:0', width: 2560, height: 1440 }) });
    const audio = { kind: 'audio', stop: vi.fn() }; const native = Object.assign(new EventTarget(), { kind: 'video', stop: vi.fn(), getSettings: () => ({ width: 1920, height: 1080 }) });
    const tracks: unknown[] = [video, audio]; const stream = { getVideoTracks: () => [video], getTracks: () => tracks,
      removeTrack: (t: unknown) => tracks.splice(tracks.indexOf(t), 1), addTrack: (t: unknown) => tracks.push(t) } as unknown as MediaStream;
    const open = vi.fn(async () => native as unknown as MediaStreamTrack);
    const result = await captureNativeScreen(connection, { video: { frameRate: { ideal: 60 } }, audio: true }, { capture: async () => stream, open });
    expect(result).toBe(stream); expect(tracks).toEqual([audio, native]); expect(video.stop).not.toHaveBeenCalled(); expect(audio.stop).not.toHaveBeenCalled();
    expect(native.getSettings()).toMatchObject({ displaySurface: 'monitor', deviceId: 'screen:0:0', width: 1920, height: 1080 });
  });
  it('never captures the primary screen when a different source was selected', async () => {
    const video = Object.assign(new EventTarget(), { stop: vi.fn(), getSettings: () => ({ displaySurface: 'monitor', deviceId: 'screen:1:0' }) });
    const stream = { getVideoTracks: () => [video], getTracks: () => [video] } as unknown as MediaStream;
    const open = vi.fn();
    await expect(captureNativeScreen(connection, { video: true }, { capture: async () => stream, open })).rejects.toThrow();
    expect(open).not.toHaveBeenCalled(); expect(video.stop).toHaveBeenCalledOnce();
    expect(getNativeDiagnosticSnapshot()!.events).toContainEqual(expect.objectContaining({ event: 'failed', code: 'unsupported-source' }));
  });

  it.each([false, true])('keeps browser revocation connected after native replacement (audio: %s)', async withAudio => {
    const selected = selectedScreen(withAudio); const h = nativeHarness();
    const pending = captureNativeScreen(connection, { video: { frameRate: 60 } }, {
      capture: async () => selected.stream,
      open: (config, rate, deps) => openNativeVideoTrack(config, rate, { ...h.deps, ...deps })
    });
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalledOnce());
    h.socket.open(); h.socket.message(format); h.socket.message(packet(1));
    const stream = await pending; const native = stream.getVideoTracks()[0]; const ended = vi.fn(); native.addEventListener('ended', ended);
    expect(selected.video.stop).not.toHaveBeenCalled();
    expect(selected.video.applyConstraints).toHaveBeenCalledWith({ frameRate: { ideal: 1, max: 1 } });
    expect(stream.getVideoTracks()).toEqual([native]);
    expect(stream.getTracks()).not.toContain(selected.video);
    selected.video.dispatchEvent(new Event('ended'));
    expect(getNativeDiagnosticSnapshot()?.events.map(e => e.event)).toContain('permission_ended');
    expect(getNativeDiagnosticSnapshot()?.events.map(e => e.event)).not.toContain('track_stop');
    expect(ended).toHaveBeenCalledOnce(); expect(h.socket.close).toHaveBeenCalledOnce();
    native.stop(); native.stop();
    expect(selected.video.stop).toHaveBeenCalledOnce(); expect(h.stop).toHaveBeenCalledOnce();
  });

  it('stops and detaches the permission sentinel when native capture ends', async () => {
    const selected = selectedScreen(false); const h = nativeHarness();
    const pending = captureNativeScreen(connection, { video: { frameRate: 60 } }, {
      capture: async () => selected.stream, open: (config, rate, deps) => openNativeVideoTrack(config, rate, { ...h.deps, ...deps })
    });
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalledOnce());
    h.socket.open(); h.socket.message(format); h.socket.message(packet(1));
    const stream = await pending;
    h.socket.dispatchEvent(new Event('close'));
    stream.getVideoTracks()[0].stop();
    selected.video.dispatchEvent(new Event('ended'));
    expect(selected.video.stop).toHaveBeenCalledOnce(); expect(h.stop).toHaveBeenCalledOnce();
  });

  it('rejects a browser source that already ended before starting native capture', async () => {
    const selected = selectedScreen(true); selected.video.readyState = 'ended'; const open = vi.fn();
    await expect(captureNativeScreen(connection, { video: true }, { capture: async () => selected.stream, open })).rejects.toMatchObject({ name: 'AbortError' });
    expect(open).not.toHaveBeenCalled(); expect(selected.audio?.stop).toHaveBeenCalledOnce();
  });
});

function selectedScreen(withAudio: boolean) {
  const video = Object.assign(new EventTarget(), { kind: 'video', readyState: 'live', stop: vi.fn(),
    applyConstraints: vi.fn(async () => {}), getSettings: () => ({ displaySurface: 'monitor', deviceId: 'screen:0:0' }) });
  const audio = withAudio ? { kind: 'audio', stop: vi.fn() } : undefined;
  const tracks = [video, ...(audio ? [audio] : [])] as unknown as MediaStreamTrack[];
  const stream = { getTracks: () => tracks, getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    removeTrack: (track: MediaStreamTrack) => tracks.splice(tracks.indexOf(track), 1), addTrack: (track: MediaStreamTrack) => tracks.push(track) } as unknown as MediaStream;
  return { stream, video, audio };
}

it('records normal native stop without mislabeling permission revocation', async () => {
  const selected = selectedScreen(false); const h = nativeHarness();
  const pending = captureNativeScreen(connection, { video: { frameRate: 60 } }, {
    capture: async () => selected.stream, open: (config, rate, deps) => openNativeVideoTrack(config, rate, { ...h.deps, ...deps })
  });
  await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalledOnce());
  h.socket.open(); h.socket.message(format); h.socket.message(packet(1));
  (await pending).getVideoTracks()[0].stop();
  const events = getNativeDiagnosticSnapshot()!.events.map(e => e.event);
  expect(events).toContain('track_stop'); expect(events).not.toContain('permission_ended'); expect(events).not.toContain('track_ended');
});

it('records revocation during native startup and never signals a normal stop', async () => {
  const selected = selectedScreen(false); const h = nativeHarness();
  const pending = captureNativeScreen(connection, { video: { frameRate: 60 } }, {
    capture: async () => selected.stream, open: (config, rate, deps) => openNativeVideoTrack(config, rate, { ...h.deps, ...deps })
  });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalledOnce());
  selected.video.dispatchEvent(new Event('ended')); await rejected;
  expect(h.stop).toHaveBeenCalledOnce(); expect(h.socket.close).toHaveBeenCalledOnce();
  expect(getNativeDiagnosticSnapshot()!.events.map(e => e.event)).toContain('permission_ended');
  expect(getNativeDiagnosticSnapshot()!.events.map(e => e.event)).not.toContain('track_stop');
});
it('correlates the HTTP response header without changing the old start request', async () => {
  const selected = selectedScreen(false); const h = nativeHarness();
  const encoded = new TextEncoder().encode(format); const bytes = new Uint8Array(4 + encoded.length + 28);
  new DataView(bytes.buffer).setUint32(0, encoded.length); bytes.set(encoded, 4); bytes.set(new Uint8Array(packet(1)), 4 + encoded.length);
  const source = httpStream([bytes]); const id = '00000000-0000-4000-8000-000000000000';
  source.response.headers.set('X-Native-Diagnostic-Id', id);
  let attempt: import('./native-diagnostics.js').NativeDiagnosticAttempt | undefined;
  const stream = await captureNativeScreen(connection, { video: { frameRate: 60 } }, {
    capture: async () => selected.stream, open: (config, rate, deps) => {
      attempt = deps?.diagnostics;
      return openNativeVideoTrack(config, rate, { ...h.deps, ...deps, createSocket: undefined, fetch: async url => String(url).endsWith('/diagnostics') ? new Response(null, { status: 403 }) : source.response });
    }
  });
  expect(attempt?.helperId).toBe(id); stream.getVideoTracks()[0].stop();
});
it('pins a helper ID before first-frame cancellation when the helper advertises diagnostics', async () => {
  const h = nativeHarness(); const diagnostics = beginNativeDiagnostics(); const abort = new AbortController();
  const request = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/diagnostics')) return new Response(null, { status: 404, headers: { 'X-Native-Diagnostics-Version': '1' } });
    return new Promise<Response>(() => {});
  });
  const pending = openNativeVideoTrack(connection, 60, { ...h.deps, createSocket: undefined, fetch: request, diagnostics, signal: abort.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(diagnostics.helperId).toBe(diagnostics.timeline.id);
  expect(request.mock.calls[1]).toEqual([expect.stringContaining('/frames-http'), expect.objectContaining({ body: JSON.stringify({ frameRate: 60, diagnosticId: diagnostics.timeline.id }) })]);
  abort.abort(); await rejected;
});
it('does not start capture if permission is revoked during diagnostic negotiation', async () => {
  const h = nativeHarness(); const abort = new AbortController(); const diagnostics = beginNativeDiagnostics();
  const request = vi.fn(() => new Promise<Response>(() => {}));
  const pending = openNativeVideoTrack(connection, 60, { ...h.deps, createSocket: undefined, fetch: request, signal: abort.signal, diagnostics });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce()); abort.abort(); await rejected;
  await Promise.resolve(); expect(request).toHaveBeenCalledOnce(); expect(h.stop).toHaveBeenCalledOnce();
});
it('uses the original HTTP start payload with an old helper and preserves browser-only export', async () => {
  const h = nativeHarness(); const diagnostics = beginNativeDiagnostics();
  const encoded = new TextEncoder().encode(format); const bytes = new Uint8Array(4 + encoded.length + 28);
  new DataView(bytes.buffer).setUint32(0, encoded.length); bytes.set(encoded, 4); bytes.set(new Uint8Array(packet(1)), 4 + encoded.length);
  const source = httpStream([bytes]);
  const request = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/diagnostics') ? new Response(null, { status: 403 }) : source.response);
  const track = await openNativeVideoTrack(connection, 60, { ...h.deps, createSocket: undefined, fetch: request, diagnostics });
  expect(request.mock.calls[1]).toEqual([expect.stringContaining('/frames-http'), expect.objectContaining({ body: '{"frameRate":60}' })]);
  expect(diagnostics.helperId).toBeUndefined(); expect(diagnostics.timeline.snapshot().events.map(e => e.event)).toContain('native_ready'); track.stop();
});
