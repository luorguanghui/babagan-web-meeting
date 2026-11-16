import { Connection, Origin, Path } from '@moq/net';
import * as Publish from '@moq/publish';
import * as Watch from '@moq/watch';
import { Signal, type Getter } from '@moq/signals';
import { computeResolutionScale } from './screen-resolution.js';
import type { MoqMediaSession } from './screen-moq.js';
import type { ScreenSharePublishOptions } from './screen-share.js';

export { supportsMoqPublisher, supportsMoqSubscriber } from './screen-moq-support.js';

interface MediaGrant {
  url: string;
  namespace: string;
}

const PROTOCOL = 'moqt-18';
const STARTUP_TIMEOUT_MS = 12_000;

class MediaSession implements MoqMediaSession {
  private readonly controller = new AbortController();
  private readonly resources: Array<() => void> = [];
  private readonly completion = Promise.withResolvers<void>();
  readonly closed = this.completion.promise;
  readonly signal = this.controller.signal;

  constructor(signal: AbortSignal) {
    signal.addEventListener('abort', this.close, { once: true });
    this.add(() => signal.removeEventListener('abort', this.close));
    if (signal.aborted) this.close();
  }

  add(dispose: () => void): void {
    if (this.signal.aborted) dispose();
    else this.resources.push(dispose);
  }

  own<T extends { close(): void }>(resource: T): T {
    this.add(() => resource.close());
    return resource;
  }

  readonly close = (): void => {
    if (this.signal.aborted) return;
    this.controller.abort();
    for (const dispose of this.resources.reverse()) {
      try { dispose(); } catch { /* Release the remaining resources. */ }
    }
    this.resources.length = 0;
    this.completion.resolve();
  };

  async until<T>(promise: Promise<T>): Promise<T> {
    return await Promise.race([
      promise,
      this.closed.then(() => { throw this.signal.reason; })
    ]);
  }
}

async function openSession<T>(signal: AbortSignal, start: (session: MediaSession) => Promise<T>, failure: string): Promise<T> {
  const session = new MediaSession(signal);
  const timer = setTimeout(session.close, STARTUP_TIMEOUT_MS);
  try {
    session.signal.throwIfAborted();
    const result = await start(session);
    session.signal.throwIfAborted();
    return result;
  } catch {
    session.close();
    if (signal.aborted) throw new DOMException('MoQ screen sharing was canceled.', 'AbortError');
    throw new Error(failure);
  } finally {
    clearTimeout(timer);
  }
}

async function connect(grant: MediaGrant, session: MediaSession, origin: Origin.Producer, role: 'publish' | 'subscribe') {
  const url = new URL(grant.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid MoQ relay URL');
  const transport = new WebTransport(url.href, {
    allowPooling: false, congestionControl: 'low-latency', protocols: [PROTOCOL]
  } as WebTransportOptions);
  session.add(() => transport.close());
  // The native transport needs the token in the URL path. The SDK must only
  // receive the origin, because its diagnostics include the pathname.
  void transport.closed.then(session.close, session.close);
  await session.until(transport.ready);
  if (!('protocol' in transport) || transport.protocol !== PROTOCOL) throw new Error('MoQ protocol unavailable');
  const peer = await session.until(Connection.connect({
    url: new URL(url.origin), transport, signal: session.signal,
    ...(role === 'publish' ? { publish: origin.consume() } : { consume: origin })
  }).then(value => session.own(value)));
  void peer.closed.then(session.close, session.close);
  return peer;
}

function cloneTrack(session: MediaSession, source: MediaStreamTrack): MediaStreamTrack {
  const track = source.clone();
  session.add(() => track.stop());
  track.contentHint = source.contentHint;
  return track;
}

export async function openMoqPublisher(
  grant: MediaGrant, stream: MediaStream, options: ScreenSharePublishOptions, signal: AbortSignal
): Promise<MoqMediaSession> {
  return openSession(signal, async session => {
    const videoSource = stream.getVideoTracks()[0];
    if (!videoSource) throw new Error('Missing screen video track');
    const origin = session.own(new Origin.Producer());
    await connect(grant, session, origin, 'publish');
    session.signal.throwIfAborted();
    const announce = new Signal(false);
    const broadcast = session.own(new Publish.Broadcast({
      origin, name: Path.from(grant.namespace), enabled: true, announce
    }));
    const track = cloneTrack(session, videoSource) as Publish.Video.StreamTrack;
    const capture = session.own(new Publish.Video.Capture({ source: { track } }));
    const sourceSize = videoSource.getSettings();
    const scale = computeResolutionScale(sourceSize);
    const codec = options.codec === 'h264' ? 'avc1' : options.codec === 'vp8' ? 'vp8' : undefined;
    const encoder = session.own(new Publish.Video.Encoder('video/screen', {
      broadcast, capture, enabled: true,
      config: {
        codec, frameRate: options.frameRate, maxBitrate: options.maxBitrate,
        maxScale: scale === undefined ? undefined : 1 / (scale * scale)
      }
    }));
    const catalogs: Array<Getter<unknown>> = [encoder.out.catalog];
    const audioSource = stream.getAudioTracks()[0];
    if (audioSource) {
      const audioTrack = cloneTrack(session, audioSource) as Publish.Audio.StreamTrack;
      const audioCapture = session.own(new Publish.Audio.Capture({
        source: { track: audioTrack, kind: 'music' }, enabled: true
      }));
      const audioEncoder = session.own(new Publish.Audio.Encoder('audio/system', {
        broadcast, capture: audioCapture, enabled: true, codec: { mime: 'opus', bitrate: 128_000 }
      }));
      catalogs.push(audioEncoder.out.catalog);
    }
    await Promise.all(catalogs.map(catalog => waitForValue(session, catalog)));
    announce.set(true);
    return session;
  }, 'MoQ screen sharing could not start.');
}

async function waitForValue<T>(session: MediaSession, signal: Getter<T | undefined>): Promise<void> {
  if (signal.peek() !== undefined) return;
  const ready = Promise.withResolvers<void>();
  const unsubscribe = signal.subscribe(value => { if (value !== undefined) ready.resolve(); });
  try {
    await session.until(ready.promise);
  } finally {
    unsubscribe();
  }
}

function attachSystemAudio(session: MediaSession, root: Getter<AudioNode | undefined>, stream: MediaStream): void {
  let release: (() => void) | undefined;
  const update = (node: AudioNode | undefined) => {
    release?.();
    release = undefined;
    if (!node) return;
    try {
      const destination = (node.context as AudioContext).createMediaStreamDestination();
      const track = destination.stream.getAudioTracks()[0];
      if (!track) return;
      release = () => {
        track.stop();
        stream.removeTrack(track);
        try { node.disconnect(destination); } catch { /* A detached worklet may already be gone. */ }
      };
      node.connect(destination);
      stream.addTrack(track);
    } catch {
      release?.();
      release = undefined;
    }
  };
  session.add(() => release?.());
  session.add(root.subscribe(update));
  update(root.peek());
}

export async function openMoqSubscriber(grant: MediaGrant, signal: AbortSignal): Promise<MoqMediaSession & { stream: MediaStream }> {
  return openSession(signal, async session => {
    const origin = session.own(new Origin.Producer());
    const peer = await connect(grant, session, origin, 'subscribe');
    const canvas = document.createElement('canvas');
    const stream = canvas.captureStream();
    session.add(() => stream.getVideoTracks().forEach(track => track.stop()));
    const player = session.own(new Watch.Player({
      origin, name: Path.from(grant.namespace), catalogFormat: 'hang', canvas, enabled: true,
      visible: 'always', volume: 0, probe: peer.probe
    }));
    // The existing meeting player owns volume and playback controls. Route the
    // decoded audio into that same MediaStream without sending sound to speakers twice.
    attachSystemAudio(session, player.audio.out.root, stream);
    await waitForValue(session, player.renderer.out.frame);
    return { close: session.close, closed: session.closed, stream };
  }, 'MoQ screen sharing could not be played.');
}
