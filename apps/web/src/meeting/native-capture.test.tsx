import { afterEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_CAPTURE_PACKET_MAGIC } from '@meeting/contracts';
import { initializeNativeCaptureConnection, readNativeCaptureConnection, openNativeVideoTrack, captureNativeScreen, getNativePacingStats } from './native-capture.js';
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
const sourceProof = { kind: 'sole-active-monitor', activeDisplayCount: 1, outputIndex: 0 };
const attestedFormat = JSON.stringify({ ...JSON.parse(format), source: sourceProof });

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
  it.each(['window', 'browser', undefined])('rejects non-monitor picker sources before contacting the helper: %s', async displaySurface => {
    const selected = selectedScreen(false, 'screen:4:0');
    selected.video.getSettings = () => ({ displaySurface, deviceId: 'screen:4:0' });
    const open = vi.fn();
    await expect(captureNativeScreen(connection, { video: true }, { capture: async () => selected.stream, open })).rejects.toBeInstanceOf(Error);
    expect(open).not.toHaveBeenCalled(); expect(selected.video.stop).toHaveBeenCalledOnce();
  });
  it('does not reuse provenance from a closed native session', async () => {
    const h = nativeHarness();
    const first = openNativeVideoTrack(connection, 60, { ...h.deps, sourcePolicy: 'single-active-monitor' });
    h.socket.open(); h.socket.message(attestedFormat); h.socket.message(packet(1));
    const track = await first; track.stop();
    const selected = selectedScreen(false, 'screen:4:0');
    await expect(captureNativeScreen(connection, { video: true }, { capture: async () => selected.stream, open: async () => track }))
      .rejects.toBeInstanceOf(Error);
    expect(selected.video.stop).toHaveBeenCalledOnce();
  });
  it('cancels an opaque-monitor request while its provenance is pending and ignores late frames', async () => {
    const selected = selectedScreen(false, 'screen:4:0'), h = nativeHarness();
    const pending = captureNativeScreen(connection, { video: { frameRate: 60 } }, { capture: async () => selected.stream,
      open: (config, rate, deps) => openNativeVideoTrack(config, rate, { ...h.deps, ...deps }) }).catch(error => error);
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalledOnce()); h.socket.open();
    selected.video.dispatchEvent(new Event('ended'));
    h.socket.message(attestedFormat); h.socket.message(packet(1));
    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(h.createFrame).not.toHaveBeenCalled(); expect(h.stop).toHaveBeenCalledOnce(); expect(h.socket.close).toHaveBeenCalledOnce();
  });
  it.each(['http', 'websocket'])('replaces a document-specific monitor ID only with authenticated provenance (%s)', async transport => {
    const selected = selectedScreen(true, 'screen:4:0'); const h = nativeHarness();
    const encoded = new TextEncoder().encode(attestedFormat), bytes = new Uint8Array(4 + encoded.length + 28);
    new DataView(bytes.buffer).setUint32(0, encoded.length); bytes.set(encoded, 4); bytes.set(new Uint8Array(packet(1)), 4 + encoded.length);
    const source = httpStream([bytes]); const request = vi.fn(async () => source.response);
    const pending = captureNativeScreen(connection, { video: { frameRate: 60 } }, {
      capture: async () => selected.stream,
      open: (config, rate, deps) => openNativeVideoTrack(config, rate, { ...h.deps, ...deps,
        ...(transport === 'http' ? { createSocket: undefined, fetch: request } : {}) })
    }).catch(error => error);
    if (transport === 'websocket') {
      await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalledOnce());
      h.socket.open(); expect(h.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'start', frameRate: 60, sourcePolicy: 'single-active-monitor' }));
      h.socket.message(attestedFormat); h.socket.message(packet(1));
    }
    const stream = await pending as MediaStream;
    expect(stream).toBe(selected.stream);
    if (transport === 'http') expect(request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: '{"frameRate":60,"sourcePolicy":"single-active-monitor"}' }));
    expect(stream.getVideoTracks()[0].getSettings()).toMatchObject({ displaySurface: 'monitor', deviceId: 'screen:4:0' });
    selected.video.dispatchEvent(new Event('ended'));
    expect(h.stop).toHaveBeenCalledOnce(); expect(selected.video.stop).toHaveBeenCalledOnce();
  });
  it.each([undefined, { ...sourceProof, activeDisplayCount: 2 }, { ...sourceProof, outputIndex: 1 }, { ...sourceProof, kind: 'window' }])('stops before allocating or publishing a frame when required provenance is missing or invalid: %j', async source => {
      const selected = selectedScreen(false, 'document-opaque-id'); const h = nativeHarness();
      const pending = captureNativeScreen(connection, { video: { frameRate: 60 } }, { capture: async () => selected.stream,
        open: (config, rate, deps) => openNativeVideoTrack(config, rate, { ...h.deps, ...deps }) }).catch(error => error);
      await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalledOnce()); h.socket.open();
      h.socket.message(JSON.stringify({ ...JSON.parse(format), ...(source ? { source } : {}) })); h.socket.message(packet(1));
      expect(await pending).toBeInstanceOf(Error); expect(h.createFrame).not.toHaveBeenCalled(); expect(h.stop).toHaveBeenCalledOnce(); expect(selected.video.stop).toHaveBeenCalledOnce();
    });
  it.each([undefined, { ...sourceProof, activeDisplayCount: 2 }])('also rejects missing or invalid provenance in the HTTP metadata header: %j', async proof => {
    const selected = selectedScreen(false, 'screen:4:0'), h = nativeHarness();
    const encoded = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(format), source: proof }));
    const bytes = new Uint8Array(4 + encoded.length + 28);
    new DataView(bytes.buffer).setUint32(0, encoded.length); bytes.set(encoded, 4); bytes.set(new Uint8Array(packet(1)), 4 + encoded.length);
    const response = httpStream([bytes]);
    await expect(captureNativeScreen(connection, { video: { frameRate: 60 } }, { capture: async () => selected.stream,
      open: (config, rate, deps) => openNativeVideoTrack(config, rate, { ...h.deps, ...deps, createSocket: undefined, fetch: async () => response.response }) }))
      .rejects.toBeInstanceOf(Error);
    expect(h.createFrame).not.toHaveBeenCalled(); expect(h.stop).toHaveBeenCalledOnce(); expect(response.cancel).toHaveBeenCalledOnce();
    expect(selected.video.stop).toHaveBeenCalledOnce();
  });
  it('does not retry an old helper rejection with a less restrictive legacy request', async () => {
    const selected = selectedScreen(false, 'document-opaque-id'), h = nativeHarness();
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 400 }));
    await expect(captureNativeScreen(connection, { video: { frameRate: 60 } }, { capture: async () => selected.stream,
      open: (config, rate, deps) => openNativeVideoTrack(config, rate, { ...h.deps, ...deps, createSocket: undefined, fetch: request }) })).rejects.toBeInstanceOf(Error);
    expect(request).toHaveBeenCalledOnce(); expect(JSON.parse(request.mock.calls[0][1]!.body as string).sourcePolicy).toBe('single-active-monitor');
    expect(h.createFrame).not.toHaveBeenCalled(); expect(h.stop).toHaveBeenCalledOnce(); expect(selected.video.stop).toHaveBeenCalledOnce();
  });
  it('reports an old WebSocket helper policy rejection without retrying legacy capture', async () => {
    const selected = selectedScreen(false, 'screen:4:0'), h = nativeHarness();
    const pending = captureNativeScreen(connection, { video: { frameRate: 60 } }, { capture: async () => selected.stream,
      open: (config, rate, deps) => openNativeVideoTrack(config, rate, { ...h.deps, ...deps }) }).catch(error => error);
    await vi.waitFor(() => expect(h.createSocket).toHaveBeenCalledOnce()); h.socket.open();
    h.socket.message(JSON.stringify({ type: 'error', code: 'invalid_control' }));
    expect(await pending).toMatchObject({ code: 'unsupported-source' });
    expect(h.socket.send.mock.calls.map(([value]) => JSON.parse(value).type)).toEqual(['start', 'stop']);
    expect(h.createFrame).not.toHaveBeenCalled(); expect(selected.video.stop).toHaveBeenCalledOnce();
  });
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
  it('never trusts copied getSettings fields as proof for a different source identifier', async () => {
    const video = Object.assign(new EventTarget(), { stop: vi.fn(), getSettings: () => ({ displaySurface: 'monitor', deviceId: 'screen:1:0' }) });
    const stream = { getVideoTracks: () => [video], getTracks: () => [video] } as unknown as MediaStream;
    const native = Object.assign(new EventTarget(), { stop: vi.fn(), getSettings: () => ({ ...sourceProof, displaySurface: 'monitor' }) });
    const open = vi.fn(async () => native as unknown as MediaStreamTrack);
    await expect(captureNativeScreen(connection, { video: true }, { capture: async () => stream, open })).rejects.toThrow();
    expect(open).toHaveBeenCalledOnce(); expect(native.stop).toHaveBeenCalledOnce(); expect(video.stop).toHaveBeenCalledOnce();
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

function selectedScreen(withAudio: boolean, deviceId = 'screen:0:0') {
  const video = Object.assign(new EventTarget(), { kind: 'video', readyState: 'live', stop: vi.fn(),
    applyConstraints: vi.fn(async () => {}), getSettings: (): MediaTrackSettings => ({ displaySurface: 'monitor', deviceId }) });
  const audio = withAudio ? { kind: 'audio', stop: vi.fn() } : undefined;
  const tracks = [video, ...(audio ? [audio] : [])] as unknown as MediaStreamTrack[];
  const stream = { getTracks: () => tracks, getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    removeTrack: (track: MediaStreamTrack) => tracks.splice(tracks.indexOf(track), 1), addTrack: (track: MediaStreamTrack) => tracks.push(track) } as unknown as MediaStream;
  return { stream, video, audio };
}
