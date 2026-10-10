import { afterEach, expect, it, vi } from 'vitest';
import { ProjectPeerReceiver } from './peer-receiver.js';
vi.mock('./audio.js', () => ({ ProjectAudioPlayback: class {
  async initialize() {} clear() {} async close() {}
} }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([30, 53, 60])('renders first and sustained %ifps frames when decoding runs before the 100ms display buffer tick', async fps => {
  let now = 0, output!: VideoDecoderInit['output'];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('VideoDecoder', class {
    static async isConfigSupported() { return { supported: true }; }
    state = 'configured'; decodeQueueSize = 0;
    constructor(options: VideoDecoderInit) { output = options.output; }
    configure() {} close() { this.state = 'closed'; }
  });
  const draw = vi.fn(), requestFrame = vi.fn(), onStream = vi.fn();
  const track = { requestFrame, stop() {} };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  let width = 0, height = 0, resizes = 0;
  const canvas = { get width() { return width; }, set width(value: number) { width = value; resizes++; },
    get height() { return height; }, set height(value: number) { height = value; resizes++; },
    getContext: () => ({ drawImage: draw }), captureStream: () => stream };
  const receiver = new ProjectPeerReceiver({ pc: {} as RTCPeerConnection, onStream, onError(message) { throw new Error(message); } });
  const internals = receiver as unknown as { canvas: object; controlMessage(raw: string): Promise<void>; tick(): void; display: unknown[] };
  internals.canvas = canvas;
  await internals.controlMessage(JSON.stringify({ type: 'config', generation: 2, codec: 'avc1.42c02a', width: 1920, height: 1080, audio: true }));
  const frames = Array.from({ length: 90 }, (_, index) => ({ timestamp: Math.round(index * 1000000 / fps), displayWidth: 1920, displayHeight: 1080, close: vi.fn() }));
  for (let index = 0; index < frames.length; index++) {
    now = index * 1000 / fps;
    output(frames[index] as unknown as VideoFrame);
    internals.tick();
  }
  expect(onStream).toHaveBeenCalledOnce();
  expect(receiver.getStats().renderedFrames).toBeGreaterThanOrEqual(80);
  expect(receiver.getStats().droppedFrames).toBe(0);
  expect(requestFrame).toHaveBeenCalledTimes(receiver.getStats().renderedFrames);
  expect(internals.display.length).toBeLessThanOrEqual(12);
  expect(resizes).toBe(2);
  await receiver.close();
  expect(frames.every(frame => frame.close.mock.calls.length === 1)).toBe(true);
});

it.each([30, 60])('keeps video-only %ifps playback alive after a sustained delivery delay', async fps => {
  let now = 0, output!: VideoDecoderInit['output'];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('VideoDecoder', class {
    static async isConfigSupported() { return { supported: true }; }
    state = 'configured'; decodeQueueSize = 0;
    constructor(options: VideoDecoderInit) { output = options.output; }
    configure() {} close() { this.state = 'closed'; }
  });
  const requestFrame = vi.fn(), track = { requestFrame, stop() {} };
  const onStream = vi.fn(), draw = vi.fn();
  const receiver = new ProjectPeerReceiver({ pc: {} as RTCPeerConnection, onStream, onError(message) { throw new Error(message); } });
  const internal = receiver as unknown as { canvas: object; controlMessage(raw: string): Promise<void>; tick(): void; display: unknown[] };
  internal.canvas = { width: 1920, height: 1080, getContext: () => ({ drawImage: draw }),
    captureStream: () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) };
  await internal.controlMessage(JSON.stringify({ type: 'config', generation: 2, codec: 'avc1.42c02a', width: 1920, height: 1080, audio: false }));
  const frames = Array.from({ length: 180 }, (_, index) => ({ timestamp: Math.round(index * 1000000 / fps), displayWidth: 1920, displayHeight: 1080, close: vi.fn() }));
  for (let index = 0; index < frames.length; index++) {
    now = index * 1000 / fps + (index >= 90 ? 450 : 0);
    output(frames[index] as unknown as VideoFrame);
    internal.tick();
  }
  expect(receiver.getStats().renderedFrames).toBe(180);
  expect(receiver.getStats().droppedFrames).toBe(0);
  expect(requestFrame).toHaveBeenCalledTimes(180);
  expect(internal.display).toHaveLength(0);
  expect(onStream).toHaveBeenCalledOnce();
  await receiver.close();
  expect(frames.every(frame => frame.close.mock.calls.length === 1)).toBe(true);
});

it('presents the first video-only decoded frame without waiting 100ms or a timer tick', async () => {
  let output!: VideoDecoderInit['output'];
  vi.spyOn(performance, 'now').mockReturnValue(500);
  vi.stubGlobal('VideoDecoder', class {
    static async isConfigSupported() { return { supported: true }; }
    state = 'configured'; decodeQueueSize = 0;
    constructor(options: VideoDecoderInit) { output = options.output; }
    configure() {} close() { this.state = 'closed'; }
  });
  const onStream = vi.fn(), requestFrame = vi.fn(), track = { requestFrame, stop() {} };
  const receiver = new ProjectPeerReceiver({ pc: {} as RTCPeerConnection, onStream, onError(message) { throw new Error(message); } });
  const internal = receiver as unknown as { canvas: object; controlMessage(raw: string): Promise<void> };
  internal.canvas = { width: 1920, height: 1080, getContext: () => ({ drawImage() {} }),
    captureStream: () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) };
  await internal.controlMessage(JSON.stringify({ type: 'config', generation: 2, codec: 'avc1.42c02a', width: 1920, height: 1080, audio: false }));
  const frame = { timestamp: 1000000, displayWidth: 1920, displayHeight: 1080, close: vi.fn() };
  output(frame as unknown as VideoFrame);
  expect(onStream).toHaveBeenCalledOnce();
  expect(requestFrame).toHaveBeenCalledOnce();
  expect(frame.close).toHaveBeenCalledOnce();
  await receiver.close();
});
