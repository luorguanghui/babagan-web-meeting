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
