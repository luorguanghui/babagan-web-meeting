import { describe, expect, it, vi } from 'vitest';
import { CloudflareScreenSession, type CloudflareScreenApi } from './cloudflare-sfu.js';

class Track extends EventTarget {
  muted = false; readyState = 'live'; contentHint = ''; stop = vi.fn();
  constructor(readonly kind: string) { super(); }
  clone() { return new Track(this.kind); }
}
class Stream {
  constructor(private tracks: Track[] = []) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  addTrack(t: Track) { this.tracks.push(t); }
}
class Pc extends EventTarget {
  connectionState = 'connected'; iceGatheringState = 'complete'; localDescription = { type: 'offer', sdp: 'local' };
  remoteDescription: unknown; ontrack?: (e: unknown) => void; close = vi.fn(); senders: Track[] = [];
  transceivers: Array<{ mid: string; sender: unknown }> = [];
  addTransceiver(t: Track) { this.senders.push(t); const tx = { mid: String(this.senders.length - 1), sender: { getParameters: () => ({ encodings: [] }), setParameters: vi.fn(async () => {}) }, setCodecPreferences: vi.fn() }; this.transceivers.push(tx); return tx; }
  createOffer = async () => ({ type: 'offer', sdp: 'local' });
  createAnswer = async () => ({ type: 'answer', sdp: 'answer' });
  setLocalDescription = async (d: typeof this.localDescription) => { this.localDescription = d; };
  setRemoteDescription = async (d: unknown) => { this.remoteDescription = d; };
  getStats = async () => new Map([['video', { type: 'outbound-rtp', kind: 'video', framesSent: 1 }]]);
}
const publication = { shareId: 'share', sessionId: 'publisher', sharerIdentity: 'Ada', sharerName: 'Ada', tracks: [{ kind: 'video' as const, trackName: 'screen' }] };
function setup(configure: (pc: Pc) => void = () => {}) {
  const pcs: Pc[] = [];
  const api: CloudflareScreenApi = {
    publish: vi.fn(async () => ({ sessionId: 'publisher', shareId: 'share', sessionDescription: { type: 'answer' as const, sdp: 'answer' }, tracks: [{ kind: 'video' as const, mid: '0', trackName: 'screen' }] })),
    ready: vi.fn(async () => {}),
    subscribe: vi.fn(async () => ({ sessionId: 'viewer', shareId: 'share', sessionDescription: { type: 'offer' as const, sdp: 'offer' }, tracks: [{ kind: 'video' as const, mid: '7', trackName: 'screen' }, { kind: 'audio' as const, mid: '8', trackName: 'audio' }] })),
    answer: vi.fn(async () => {}), close: vi.fn(async () => {})
  };
  const create = (onStream = vi.fn()) => new CloudflareScreenSession({ api, fetchIceServers: async () => [], createPeerConnection: () => { const pc = new Pc(); configure(pc); pcs.push(pc); return pc as unknown as RTCPeerConnection; }, createMediaStream: () => new Stream() as unknown as MediaStream, onStream });
  return { pcs, api, create };
}
describe('Cloudflare native screen session', () => {
  it('continues with gathered candidates when a slow ICE server has not completed', async () => {
    vi.useFakeTimers();
    try {
      const { create, api } = setup(pc => {
        pc.iceGatheringState = 'gathering';
        pc.createOffer = async () => ({ type: 'offer', sdp: 'v=0\r\na=candidate:1 1 udp 123 192.0.2.1 1234 typ host\r\n' });
      });
      const publisher = create();
      const publishing = publisher.publish(new Stream([new Track('video')]) as unknown as MediaStream, { codec: 'h264', maxBitrate: 8000000, frameRate: 60, degradationPreference: 'maintain-resolution' });
      const result = publishing.catch(e => e.message);
      await vi.advanceTimersByTimeAsync(8000);
      expect(await result).toBeUndefined();
      expect(api.publish).toHaveBeenCalledOnce();
      expect(api.ready).toHaveBeenCalledOnce();
      await publisher.close();
    } finally { vi.useRealTimers(); }
  });
  it('answers with gathered candidates even when another ICE request is still pending', async () => {
    vi.useFakeTimers();
    try {
      const { create, api } = setup(pc => {
        pc.iceGatheringState = 'gathering';
        pc.createAnswer = async () => ({ type: 'answer', sdp: 'v=0\r\na=candidate:1 1 udp 123 192.0.2.1 1234 typ host\r\n' });
      });
      const viewer = create();
      const subscribing = viewer.subscribe(publication);
      const result = subscribing.catch(e => e.message);
      await vi.advanceTimersByTimeAsync(8000);
      expect(await result).toBeUndefined();
      expect(api.answer).toHaveBeenCalledOnce();
      await viewer.close();
    } finally { vi.useRealTimers(); }
  });
  it('waits for gathered ICE SDP and fails once at the bounded gathering deadline', async () => {
    vi.useFakeTimers();
    try {
      const { create, api } = setup(pc => { pc.iceGatheringState = 'gathering'; });
      const failed = create().publish(new Stream([new Track('video')]) as unknown as MediaStream, { codec: 'h264', maxBitrate: 8000000, frameRate: 60, degradationPreference: 'maintain-resolution' }).catch(e => e.message);
      await vi.advanceTimersByTimeAsync(7999); expect(api.publish).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(await failed).toMatch(/timed out/); expect(api.publish).not.toHaveBeenCalled(); expect(api.ready).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('closes a silent connected publisher without announcing readiness or allocating again', async () => {
    vi.useFakeTimers();
    try {
      const { create, api } = setup(pc => { pc.getStats = async () => new Map([['video', { type: 'outbound-rtp', kind: 'video', framesSent: 0 }]]); });
      const failed = create().publish(new Stream([new Track('video')]) as unknown as MediaStream, { codec: 'h264', maxBitrate: 8000000, frameRate: 60, degradationPreference: 'maintain-resolution' }).catch(e => e.message);
      await vi.advanceTimersByTimeAsync(5000); expect(await failed).toMatch(/did not send video/);
      expect(api.ready).not.toHaveBeenCalled(); expect(api.publish).toHaveBeenCalledOnce(); expect(api.close).toHaveBeenCalledWith('publisher');
    } finally { vi.useRealTimers(); }
  });
  it('serializes remote answer and close mutations on a stopped receiver', async () => {
    const { create, api } = setup(); let resolve!: () => void;
    api.answer = vi.fn(() => new Promise<void>(r => { resolve = r; }));
    const viewer = create(); const starting = viewer.subscribe(publication); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const stopping = viewer.close(); expect(api.close).not.toHaveBeenCalled(); resolve(); await Promise.all([starting, stopping]); expect(api.close).toHaveBeenCalledOnce();
  });
  it('advertises readiness only after the connected publisher actually sends video', async () => {
    vi.useFakeTimers();
    try {
      const { pcs, create, api } = setup();
      const source = create(); const starting = source.publish(new Stream([new Track('video')]) as unknown as MediaStream, { codec: 'h264', maxBitrate: 8000000, frameRate: 60, degradationPreference: 'maintain-resolution' });
      await Promise.resolve(); await Promise.resolve();
      let frames = 0; pcs[0].getStats = async () => new Map([['video', { type: 'outbound-rtp', kind: 'video', framesSent: frames }]]);
      await vi.advanceTimersByTimeAsync(0); expect(api.ready).not.toHaveBeenCalled();
      frames = 2; await vi.advanceTimersByTimeAsync(250); await starting; expect(api.ready).toHaveBeenCalledOnce(); await source.close();
    } finally { vi.useRealTimers(); }
  });
  it('publishes one encoder for four independent subscribers and keeps original capture alive', async () => {
    const { pcs, api, create } = setup(); const raw = new Stream([new Track('video'), new Track('audio')]); const source = create();
    await source.publish(raw as unknown as MediaStream, { codec: 'h264', maxBitrate: 8000000, frameRate: 60, degradationPreference: 'maintain-resolution' });
    for (let i = 0; i < 4; i++) await create().subscribe(publication);
    expect(pcs).toHaveLength(5); expect(pcs[0].senders.map(t => t.kind)).toEqual(['video', 'audio']); expect(pcs.slice(1).flatMap(pc => pc.senders)).toHaveLength(0);
    expect(api.ready).toHaveBeenCalledOnce(); await source.close(); expect(raw.getTracks().every(t => t.stop.mock.calls.length === 0)).toBe(true); expect(pcs[0].senders.every(t => t.stop.mock.calls.length === 1)).toBe(true);
  });
  it('maps remote mids and waits for video unmute before showing stream; late audio joins same stream', async () => {
    const { pcs, create, api } = setup(); const shown = vi.fn(); const viewer = create(shown); await viewer.subscribe(publication);
    expect(api.answer).toHaveBeenCalledWith('viewer', { type: 'answer', sdp: 'answer' });
    const video = new Track('video'); video.muted = true; pcs[0].ontrack?.({ track: video, transceiver: { mid: '7' } }); expect(shown).not.toHaveBeenCalled();
    video.muted = false; video.dispatchEvent(new Event('unmute')); expect(shown).toHaveBeenCalledOnce();
    const audio = new Track('audio'); pcs[0].ontrack?.({ track: audio, transceiver: { mid: '8' } }); expect(shown.mock.calls[0][0].getTracks()).toEqual([video, audio]);
    await viewer.close(); expect(video.stop).toHaveBeenCalledOnce(); expect(audio.stop).toHaveBeenCalledOnce();
  });
  it('cleans a late allocation after stop without answering or advertising readiness', async () => {
    const { create, api } = setup(); let resolve!: (v: Awaited<ReturnType<CloudflareScreenApi['subscribe']>>) => void;
    api.subscribe = () => new Promise(r => { resolve = r; }); const viewer = create(); const starting = viewer.subscribe(publication); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const stopping = viewer.close(); resolve({ sessionId: 'late', shareId: 'share', sessionDescription: { type: 'offer' as const, sdp: 'offer' }, tracks: [{ kind: 'video' as const, mid: '7', trackName: 'screen' }] }); await Promise.all([starting, stopping]);
    expect(api.close).toHaveBeenCalledWith('late'); expect(api.answer).not.toHaveBeenCalled();
  });
});
