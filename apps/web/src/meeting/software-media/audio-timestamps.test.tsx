import { afterEach, expect, it, vi } from 'vitest';
import { ProjectAudioCapture, ProjectAudioPlayback } from './audio.js';
import { PlaybackClock } from './playback-clock.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function setupPlayback() {
  const messages: Array<{ samples: Float32Array; startFrame: number } | { type: string }> = [];
  const outputs: AudioDecoderInit['output'][] = [];
  const contexts: Array<{ currentTime: number; onstatechange?: () => void }> = [];
  vi.spyOn(performance, 'now').mockReturnValue(100);
  vi.stubGlobal('AudioDecoder', class {
    static isConfigSupported = async () => ({ supported: true });
    state = 'configured'; decodeQueueSize = 0;
    constructor(options: AudioDecoderInit) { outputs.push(options.output); }
    configure() {} decode() {} close() { this.state = 'closed'; }
  });
  vi.stubGlobal('EncodedAudioChunk', class { constructor(readonly options: EncodedAudioChunkInit) {} });
  vi.stubGlobal('AudioContext', class {
    state = 'running'; currentTime = 0;
    constructor() { contexts.push(this); }
    audioWorklet = { addModule: async () => {} };
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [{ stop() {} }] } }; }
    async resume() {} async close() { this.state = 'closed'; }
  });
  vi.stubGlobal('AudioWorkletNode', class {
    port = { postMessage: (message: { samples: Float32Array; startFrame: number }) => messages.push(message) };
    connect() {} disconnect() {}
  });
  const clock = new PlaybackClock();
  const playback = new ProjectAudioPlayback(clock, message => { throw new Error(message); });
  await playback.initialize();
  const emit = (timestamp: number, numberOfFrames = 960, output = outputs.at(-1)!) => {
    const close = vi.fn();
    output({ timestamp, numberOfFrames, numberOfChannels: 2,
      copyTo: (destination: Float32Array) => destination.fill(.2), close } as unknown as AudioData);
    return close;
  };
  return { playback, clock, outputs, emit, context: contexts[0], pcm: () => messages.filter(message => 'samples' in message) };
}
it('keeps missing Opus packet time as silence when the decoder returns continuous timestamps', async () => {
  const { playback, emit, pcm } = await setupPlayback();
  playback.packet(new Uint8Array([1]), 1000000);
  playback.packet(new Uint8Array([2]), 1060000); // Two 20ms packets were lost.
  emit(1000000); emit(1020000); // Native decoder compacted the missing time.
  expect(pcm()).toHaveLength(2);
  expect(pcm()[1].startFrame - pcm()[0].startFrame).toBe(2880);
  await playback.close();
});
it('splits a coalesced PCM output at a missing packet boundary', async () => {
  const { playback, emit, pcm } = await setupPlayback();
  playback.packet(new Uint8Array([1]), 1000000);
  playback.packet(new Uint8Array([2]), 1060000);
  emit(1000000, 1920);
  expect(pcm().map(message => message.samples.length)).toEqual([1920, 1920]);
  expect(pcm()[1].startFrame - pcm()[0].startFrame).toBe(2880);
  await playback.close();
});
it('rejects decoded audio left over from the previous media generation', async () => {
  const { playback, clock, outputs, emit, pcm } = await setupPlayback();
  playback.packet(new Uint8Array([1]), 1000000);
  const old = outputs[0]; clock.reset(); playback.clear();
  playback.packet(new Uint8Array([2]), 2000000);
  expect(emit(1000000, 960, old)).toHaveBeenCalledOnce();
  expect(pcm()).toHaveLength(0);
  emit(1020000);
  expect(pcm()).toHaveLength(1);
  await playback.close();
});
it('calibrates the playback clock after the audio graph starts, rather than at resume', async () => {
  const { playback, clock, context, emit, pcm } = await setupPlayback();
  clock.anchor(1000000, 100);
  vi.mocked(performance.now).mockReturnValue(150);
  context.currentTime = .02; // Graph started 30ms after resume returned.
  playback.packet(new Uint8Array([1]), 1000000); emit(1000000);
  expect(pcm()[0].startFrame).toBe(3360); // 20ms cursor + 50ms until common due time.
  await playback.close();
});
it('calibrates captured PCM timestamps from the running graph instead of its suspended zero clock', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(100);
  const track = { clone: () => ({ stop() {} }) } as unknown as MediaStreamTrack;
  const pcm: Array<{ timestampUs: number }> = [];
  const contexts: Array<{ currentTime: number; onstatechange?: () => void }> = [];
  let capturePort!: { onmessage?: (event: MessageEvent) => void };
  vi.stubGlobal('Worker', class {
    onmessage?: (event: MessageEvent) => void;
    postMessage(data: { type: string; timestampUs: number }) {
      if (data.type === 'pcm') pcm.push(data);
      else queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: { type: data.type === 'init' ? 'ready' : 'stopped' } })));
    }
    terminate() {}
  });
  vi.stubGlobal('MediaStream', class {});
  vi.stubGlobal('AudioContext', class {
    state = 'running'; currentTime = 0;
    constructor() { contexts.push(this); }
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    async resume() {} async close() { this.state = 'closed'; }
  });
  vi.stubGlobal('AudioWorkletNode', class {
    port = {}; constructor() { capturePort = this.port; }
    connect() {} disconnect() {}
  });
  const capture = new ProjectAudioCapture(() => {}, message => { throw new Error(message); });
  await capture.start(track);
  now.mockReturnValue(150); contexts[0].currentTime = .02;
  capturePort.onmessage?.(new MessageEvent('message', { data: { data: new Float32Array(1920), contextTime: 0 } }));
  expect(pcm[0].timestampUs).toBe(Math.round((performance.timeOrigin + 130) * 1000));
  now.mockReturnValue(1000); contexts[0].onstatechange?.();
  capturePort.onmessage?.(new MessageEvent('message', { data: { data: new Float32Array(1920), contextTime: .02 } }));
  expect(pcm[1].timestampUs).toBe(Math.round((performance.timeOrigin + 1000) * 1000));
  await capture.close();
});
