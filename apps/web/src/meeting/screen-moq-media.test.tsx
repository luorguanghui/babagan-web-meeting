import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection } from '@moq/net';
import { openMoqPublisher, openMoqSubscriber } from './screen-moq-media.js';
import type { ScreenSharePublishOptions } from './screen-share.js';

const {
  playerFrames, playerAudio, decoderVideo, decoderAudio, videoConfig, audioConfig, videoDisplay,
  encoderCatalog, encoderStats, encoderResolved, audioCatalog, audioStats, closedResources
} = vi.hoisted(() => ({
  playerFrames: { peek: vi.fn(), subscribe: vi.fn() },
  playerAudio: { peek: vi.fn(), subscribe: vi.fn() },
  decoderVideo: { peek: vi.fn() },
  decoderAudio: { peek: vi.fn() },
  videoConfig: { peek: vi.fn() },
  audioConfig: { peek: vi.fn() },
  videoDisplay: { peek: vi.fn() },
  encoderCatalog: { peek: vi.fn(), subscribe: vi.fn() },
  encoderStats: { peek: vi.fn() },
  encoderResolved: { peek: vi.fn() },
  audioCatalog: { peek: vi.fn(), subscribe: vi.fn() },
  audioStats: { peek: vi.fn() },
  closedResources: vi.fn()
}));

vi.mock('@moq/net', async importOriginal => {
  const original = await importOriginal<typeof import('@moq/net')>();
  return { ...original, Connection: { connect: vi.fn() } };
});
vi.mock('@moq/publish', () => {
  class Resource { close = closedResources; }
  class VideoEncoder extends Resource { out = { catalog: encoderCatalog, stats: encoderStats, resolved: encoderResolved }; }
  class AudioEncoder extends Resource { out = { catalog: audioCatalog, stats: audioStats }; }
  return { Broadcast: Resource, Video: { Capture: Resource, Encoder: VideoEncoder }, Audio: { Capture: Resource, Encoder: AudioEncoder } };
});
vi.mock('@moq/watch', () => ({
  Player: class {
    renderer = { out: { frame: playerFrames } };
    video = { out: { display: videoDisplay, stats: decoderVideo }, source: { out: { config: videoConfig } } };
    audio = { out: { root: playerAudio, stats: decoderAudio }, source: { out: { config: audioConfig } } };
    close = closedResources;
  }
}));

const grant = { url: 'https://draft-18.cloudflare.mediaoverquic.com/test-token', namespace: 'meeting/unique' };
const options: ScreenSharePublishOptions = { codec: 'h264', frameRate: 30, maxBitrate: 4_000_000, degradationPreference: 'maintain-resolution' };

function mediaTrack(kind: 'video' | 'audio') {
  const owned = { kind, stop: vi.fn() };
  const original = { kind, stop: vi.fn(), clone: vi.fn(() => owned), getSettings: () => ({ width: 1920, height: 1080 }) };
  return { owned, original };
}

function stream(...tracks: ReturnType<typeof mediaTrack>['original'][]) {
  return {
    getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio')
  } as unknown as MediaStream;
}

class TestWebTransport {
  static last: TestWebTransport;
  get protocol() { return 'moqt-18'; }
  readonly ready = Promise.resolve();
  readonly closed = new Promise(() => {});
  readonly close = vi.fn();
  constructor(readonly url: string) { TestWebTransport.last = this; }
}

let peer: ReturnType<typeof Promise.withResolvers<null>>;
let peerClose: ReturnType<typeof vi.fn>;
let peerStats: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  peer = Promise.withResolvers<null>();
  peerClose = vi.fn();
  peerStats = vi.fn(async () => ({}));
  encoderCatalog.peek.mockReturnValue({ codec: 'avc1.640028' });
  audioCatalog.peek.mockReturnValue({ codec: 'opus' });
  playerAudio.subscribe.mockReturnValue(vi.fn());
  vi.mocked(Connection.connect).mockResolvedValue({
    close: peerClose, closed: peer.promise, stats: peerStats
  } as unknown as Awaited<ReturnType<typeof Connection.connect>>);
  vi.stubGlobal('WebTransport', TestWebTransport);
});

afterEach(() => {
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MoQ browser media sessions', () => {
  it('keeps the relay token out of SDK URLs and stops only the publisher’s owned clones on disconnect', async () => {
    const video = mediaTrack('video');
    const audio = mediaTrack('audio');
    const session = await openMoqPublisher(grant, stream(video.original, audio.original), options, new AbortController().signal);
    expect(TestWebTransport.last.url).toBe(grant.url);
    expect(vi.mocked(Connection.connect).mock.calls[0]?.[0].url.href).toBe('https://draft-18.cloudflare.mediaoverquic.com/');

    peer.resolve(null);
    await session.closed;
    session.close();
    expect(video.owned.stop).toHaveBeenCalledOnce();
    expect(audio.owned.stop).toHaveBeenCalledOnce();
    expect(video.original.stop).not.toHaveBeenCalled();
    expect(audio.original.stop).not.toHaveBeenCalled();
    expect(peerClose).toHaveBeenCalledOnce();
  });

  it('returns a secret-free error and closes the transport after a setup failure', async () => {
    vi.mocked(Connection.connect).mockRejectedValue(new Error('rejected ' + grant.url));
    const video = mediaTrack('video');
    await expect(openMoqPublisher(grant, stream(video.original), options, new AbortController().signal)).rejects.toThrow(/^MoQ screen sharing could not start\.$/);
    expect(TestWebTransport.last.close).toHaveBeenCalledOnce();
    expect(video.original.stop).not.toHaveBeenCalled();
  });

  it('reads cumulative encoded media counters and the negotiated relay statistics', async () => {
    encoderCatalog.peek.mockReturnValue({ codec: 'avc1.640028', codedWidth: 1600, codedHeight: 900 });
    encoderStats.peek.mockReturnValue({ frames: 21, bytes: 23_456 });
    audioStats.peek.mockReturnValue({ bytes: 543 });
    peerStats.mockResolvedValue({ rtt: 18.5, bytesSent: 24_200, bytesReceived: 65 });
    const session = await openMoqPublisher(grant, stream(mediaTrack('video').original, mediaTrack('audio').original),
      options, new AbortController().signal);
    expect(await session.readStats?.()).toEqual({
      protocol: 'moqt-18', codec: 'avc1.640028', width: 1600, height: 900,
      frameCount: 21, videoBytes: 23_456, audioBytes: 543, hasAudio: true,
      relayRttMs: 18.5, transportBytesSent: 24_200, transportBytesReceived: 65
    });
    encoderStats.peek.mockReturnValue({ frames: 29, bytes: 26_491 });
    expect(await session.readStats?.()).toMatchObject({ frameCount: 29, videoBytes: 26_491 });
    session.close();
  });

  it('reads viewer media counters when transport statistics are unavailable', async () => {
    playerFrames.peek.mockReturnValue({ timestamp: 100 });
    decoderVideo.peek.mockReturnValue({ frameCount: 38, bytesReceived: 30_245 });
    decoderAudio.peek.mockReturnValue({ bytesReceived: 777 });
    videoConfig.peek.mockReturnValue({ codec: 'vp8', codedWidth: 1920, codedHeight: 1088 });
    videoDisplay.peek.mockReturnValue({ width: 1920, height: 1080 });
    audioConfig.peek.mockReturnValue({ codec: 'opus' });
    peerStats.mockRejectedValue(new Error('transport stats unavailable ' + grant.url));
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
      configurable: true, value: () => ({ getVideoTracks: () => [] })
    });
    const session = await openMoqSubscriber(grant, new AbortController().signal);
    expect(await session.readStats?.()).toEqual({
      protocol: 'moqt-18', codec: 'vp8', width: 1920, height: 1080,
      frameCount: 38, videoBytes: 30_245, audioBytes: 777, hasAudio: true
    });
    session.close();
  });

  it('does not report publication ready without a supported encoder and live input frame', async () => {
    encoderCatalog.peek.mockReturnValue(undefined);
    const dispose = vi.fn();
    encoderCatalog.subscribe.mockReturnValue(dispose);
    const abort = new AbortController();
    const video = mediaTrack('video');
    const startup = openMoqPublisher(grant, stream(video.original), options, abort.signal);
    await vi.waitFor(() => expect(encoderCatalog.subscribe).toHaveBeenCalledOnce());
    abort.abort();
    await expect(startup).rejects.toMatchObject({ name: 'AbortError' });
    expect(dispose).toHaveBeenCalledOnce();
    expect(video.owned.stop).toHaveBeenCalledOnce();
  });

  it('stops the viewer output tracks when the caller aborts', async () => {
    const output = { stop: vi.fn() };
    const audio = { stop: vi.fn() };
    const returnedStream = { getVideoTracks: () => [output], getTracks: () => [output], addTrack: vi.fn(), removeTrack: vi.fn() };
    const source = {
      context: { createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [audio] } }) },
      connect: vi.fn(),
      disconnect: vi.fn()
    };
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
      configurable: true, value: () => returnedStream
    });
    playerFrames.peek.mockReturnValue({ timestamp: 100 });
    playerAudio.peek.mockReturnValue(source);
    const abort = new AbortController();
    try {
      const session = await openMoqSubscriber(grant, abort.signal);
      expect(session.stream).toBe(returnedStream);
      expect(returnedStream.addTrack).toHaveBeenCalledWith(audio);
      abort.abort();
      await session.closed;
      expect(output.stop).toHaveBeenCalledOnce();
      expect(audio.stop).toHaveBeenCalledOnce();
      expect(source.disconnect).toHaveBeenCalledOnce();
    } finally {
      Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream');
    }
  });
});
