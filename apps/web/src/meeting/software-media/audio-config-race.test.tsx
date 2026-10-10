import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ wait: Promise.resolve(), track: { id: 'audio' } }));
vi.mock('./audio.js', () => ({ ProjectAudioPlayback: class {
  track?: object;
  async initialize() { await state.wait; this.track = state.track; }
  clear() {} async close() {} async resume() {} get blocked() { return false; }
} }));
import { ProjectPeerReceiver } from './peer-receiver.js';
afterEach(() => vi.unstubAllGlobals());
it('waits for shared audio initialization across overlapping configs and attaches the track', async () => {
  let complete!: () => void;
  state.wait = new Promise<void>(resolve => { complete = resolve; });
  vi.stubGlobal('VideoDecoder', class { state = 'configured'; static async isConfigSupported() { return { supported: true }; } configure() {} close() { this.state = 'closed'; } });
  const sent: string[] = [], tracks: object[] = [];
  const receiver = new ProjectPeerReceiver({ pc: {} as RTCPeerConnection, onStream() {}, onError() {} });
  const internals = receiver as unknown as { control: object; stream: object; controlMessage(raw: string): Promise<void> };
  internals.control = { readyState: 'open', send(raw: string) { sent.push(raw); }, close() {} };
  internals.stream = { getAudioTracks: () => tracks, getTracks: () => [], addTrack(track: object) { tracks.push(track); } };
  const config = (generation: number) => JSON.stringify({ type: 'config', generation, codec: 'vp8', width: 640, height: 360, audio: true });
  const first = internals.controlMessage(config(2));
  await new Promise(resolve => setTimeout(resolve, 0));
  const newer = internals.controlMessage(config(3));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sent.some(raw => JSON.parse(raw).type === 'ready')).toBe(false);
  complete(); await Promise.all([first, newer]);
  expect(sent.map(raw => JSON.parse(raw).generation)).toEqual([3]);
  expect(tracks).toEqual([state.track]);
  await receiver.close();
});
it('keeps the shared audio/video synchronization buffer when audio is configured', async () => {
  state.wait = Promise.resolve();
  let now = 1000, output!: VideoDecoderInit['output'];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('VideoDecoder', class {
    state = 'configured'; decodeQueueSize = 0;
    static async isConfigSupported() { return { supported: true }; }
    constructor(options: VideoDecoderInit) { output = options.output; }
    configure() {} close() { this.state = 'closed'; }
  });
  const onStream = vi.fn(), requestFrame = vi.fn(), videoTrack = { requestFrame, stop() {} }, audioTracks: object[] = [];
  const receiver = new ProjectPeerReceiver({ pc: {} as RTCPeerConnection, onStream, onError(message) { throw new Error(message); } });
  const internal = receiver as unknown as { canvas: object; controlMessage(raw: string): Promise<void>; tick(): void };
  internal.canvas = { width: 1920, height: 1080, getContext: () => ({ drawImage() {} }),
    captureStream: () => ({ getVideoTracks: () => [videoTrack], getTracks: () => [videoTrack], addTrack(track: object) { audioTracks.push(track); } }) };
  await internal.controlMessage(JSON.stringify({ type: 'config', generation: 2, codec: 'avc1.42c02a', width: 1920, height: 1080, audio: true }));
  const frame = { timestamp: 1000000, displayWidth: 1920, displayHeight: 1080, close: vi.fn() };
  output(frame as unknown as VideoFrame); internal.tick();
  expect(onStream).not.toHaveBeenCalled();
  now = 1100; internal.tick();
  expect(onStream).toHaveBeenCalledOnce();
  expect(requestFrame).toHaveBeenCalledOnce();
  expect(audioTracks).toEqual([state.track]);
  await receiver.close();
  expect(frame.close).toHaveBeenCalledOnce();
  vi.restoreAllMocks();
});
