import { afterEach, expect, it, vi } from 'vitest';
import type { ClientHostEvent } from '@meeting/contracts';
import { captureAndroidScreen } from './android-capture.js';
import type { ClientHost } from './host-bridge.js';
import { isNativeCaptureTrack } from '../meeting/native-capture.js';
import { createScreenShareController } from '../meeting/screen-share.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class Track extends EventTarget {
  kind = 'video'; readyState = 'live';
  stop = vi.fn(() => { this.readyState = 'ended'; });
  getSettings = () => ({ width: 640, height: 360 });
}
class Peer {
  onicecandidate?: (event: { candidate: null | { toJSON(): RTCIceCandidateInit } }) => void;
  ontrack?: (event: { track: MediaStreamTrack }) => void;
  onconnectionstatechange?: () => void;
  connectionState = 'new'; localDescription?: RTCSessionDescriptionInit;
  remoteGate = Promise.resolve();
  setRemoteDescription = vi.fn(async () => { await this.remoteGate; });
  addIceCandidate = vi.fn(async () => {});
  createAnswer = vi.fn(async () => ({ type: 'answer' as const, sdp: 'answer-sdp' }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => { this.localDescription = description; });
  close = vi.fn(() => { this.connectionState = 'closed'; });
}
function harness() {
  const peer = new Peer(); const start = deferred<unknown>(); const events = new Set<(event: ClientHostEvent) => void>();
  const request = vi.fn(async (method: string) => method === 'capture.start' ? start.promise : {});
  const host = { platform: 'android', request, subscribe: (listener: (event: ClientHostEvent) => void) => { events.add(listener); return () => { events.delete(listener); }; } } as unknown as ClientHost;
  const lifecycle = new EventTarget(); const abort = new AbortController(); const track = new Track(); const originalStop = track.stop;
  const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream;
  const promise = captureAndroidScreen(host, { video: { frameRate: { ideal: 60 } }, audio: true }, {
    sessionId: 'session-a', signal: abort.signal, createPeer: () => peer as unknown as RTCPeerConnection,
    createStream: () => stream, lifecycle: lifecycle as unknown as Window, negotiationTimeoutMs: 1000,
  });
  const emit = (event: ClientHostEvent) => { for (const listener of events) listener(event); };
  const offer = { sessionId: 'session-a', offer: { type: 'offer', sdp: 'offer-sdp' }, width: 864, height: 1920, frameRate: 30 };
  return { peer, start, events, request, lifecycle, abort, track, originalStop, stream, promise, emit, offer };
}
afterEach(() => { vi.useRealTimers(); });

it('queues scoped ICE until the offer is ready and returns the actual native video format', async () => {
  const h = harness(); const remote = deferred<void>(); h.peer.remoteGate = remote.promise;
  h.emit({ v: 1, event: 'capture.signal', sessionId: 'other', candidate: { candidate: 'wrong' } });
  h.emit({ v: 1, event: 'capture.signal', sessionId: 'session-a', candidate: { candidate: 'early', sdpMid: '0' } });
  h.emit({ v: 1, event: 'capture.signal', sessionId: 'session-a', candidate: null });
  h.start.resolve(h.offer); await vi.waitFor(() => expect(h.peer.setRemoteDescription).toHaveBeenCalled());
  expect(h.peer.addIceCandidate).not.toHaveBeenCalled(); remote.resolve();
  await vi.waitFor(() => expect(h.peer.setLocalDescription).toHaveBeenCalled());
  h.peer.ontrack!({ track: h.track as unknown as MediaStreamTrack });
  expect(await h.promise).toBe(h.stream);
  expect(h.request).toHaveBeenCalledWith('capture.start', { sessionId: 'session-a', width: 1920, height: 1080, frameRate: 60, audio: false }, expect.anything());
  expect(h.peer.addIceCandidate.mock.calls).toEqual([[{ candidate: 'early', sdpMid: '0' }], [undefined]]);
  expect(h.track.getSettings()).toMatchObject({ width: 864, height: 1920, frameRate: 30, displaySurface: 'monitor' });
  expect(isNativeCaptureTrack(h.track as unknown as MediaStreamTrack)).toBe(true);
  h.emit({ v: 1, event: 'capture.resized', sessionId: 'session-a', width: 1920, height: 864 });
  expect(h.track.getSettings()).toMatchObject({ width: 1920, height: 864, frameRate: 30 });
  h.peer.onicecandidate!({ candidate: { toJSON: () => ({ candidate: 'local', sdpMid: '0' }) } });
  expect(h.request).toHaveBeenCalledWith('capture.signal', { sessionId: 'session-a', candidate: { candidate: 'local', sdpMid: '0' } }, expect.anything());
  h.track.stop(); expect(h.originalStop).toHaveBeenCalledOnce(); expect(h.peer.close).toHaveBeenCalledOnce(); expect(h.events.size).toBe(0);
});

it('stops the host immediately during consent and discards a late permission result', async () => {
  const h = harness(); const rejected = expect(h.promise).rejects.toMatchObject({ name: 'AbortError' });
  h.abort.abort(); await rejected;
  expect(h.request).toHaveBeenCalledWith('capture.stop', { sessionId: 'session-a' }, expect.anything());
  h.start.resolve(h.offer); await Promise.resolve(); await Promise.resolve();
  expect(h.peer.setRemoteDescription).not.toHaveBeenCalled();
  h.peer.ontrack!({ track: h.track as unknown as MediaStreamTrack }); expect(h.originalStop).toHaveBeenCalledOnce();
});

it('ends the exposed track exactly once for a scoped native-ended event', async () => {
  const h = harness(); h.start.resolve(h.offer); await vi.waitFor(() => expect(h.peer.setLocalDescription).toHaveBeenCalled());
  h.peer.ontrack!({ track: h.track as unknown as MediaStreamTrack }); await h.promise;
  const ended = vi.fn(); h.track.addEventListener('ended', ended);
  h.emit({ v: 1, event: 'capture.ended', sessionId: 'other' }); expect(ended).not.toHaveBeenCalled();
  h.emit({ v: 1, event: 'capture.ended', sessionId: 'session-a', reason: 'system-stop' });
  h.emit({ v: 1, event: 'capture.ended', sessionId: 'session-a', reason: 'system-stop' });
  expect(ended).toHaveBeenCalledOnce(); expect(h.originalStop).toHaveBeenCalledOnce(); expect(h.track.readyState).toBe('ended');
});

it('cancels pending capture on navigation without waiting for system consent', async () => {
  const h = harness(); const rejected = expect(h.promise).rejects.toMatchObject({ name: 'AbortError' });
  h.lifecycle.dispatchEvent(new Event('pagehide')); await rejected;
  expect(h.request).toHaveBeenCalledWith('capture.stop', { sessionId: 'session-a' }, expect.anything()); expect(h.peer.close).toHaveBeenCalledOnce();
});

it('releases an existing screen-share publication when the Android system ends capture', async () => {
  const h = harness(); const releaseGrant = vi.fn(async () => {}); const release = vi.fn(async () => {});
  const controller = createScreenShareController({ requestGrant: async () => {}, releaseGrant, getDisplayMedia: () => h.promise, publisher: { publish: async () => {}, release } });
  const sharing = controller.start(); h.start.resolve(h.offer);
  await vi.waitFor(() => expect(h.peer.setLocalDescription).toHaveBeenCalled());
  h.peer.ontrack!({ track: h.track as unknown as MediaStreamTrack }); await sharing;
  expect(controller.getState().status).toBe('sharing');
  h.emit({ v: 1, event: 'capture.ended', sessionId: 'session-a', reason: 'notification-stop' });
  await vi.waitFor(() => expect(controller.getState().status).toBe('idle'));
  expect(releaseGrant).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledWith(h.stream);
});

it('rejects a stale offer and a negotiation that never produces a video track', async () => {
  const stale = harness(); const rejected = expect(stale.promise).rejects.toMatchObject({ code: 'protocol' });
  stale.start.resolve({ ...stale.offer, sessionId: 'other' }); await rejected; expect(stale.peer.setRemoteDescription).not.toHaveBeenCalled();
  vi.useFakeTimers(); const h = harness(); const timeout = expect(h.promise).rejects.toMatchObject({ code: 'timeout' });
  h.start.resolve(h.offer); await vi.advanceTimersByTimeAsync(1001); await timeout; expect(h.peer.close).toHaveBeenCalledOnce();
});
