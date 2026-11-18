import { expect, it } from 'vitest';
import { summarizeMoqStats, type MoqStatsSample } from './screen-moq-stats.js';

it('reports measured MoQ payload, relay traffic and playback rates on the same session', () => {
  const session = {};
  const stream = {} as MediaStream;
  const first: MoqStatsSample = {
    session, at: 1_000, media: { protocol: 'moqt-18', frameCount: 10, videoBytes: 400_000, audioBytes: 0, transportBytesReceived: 500_000 },
    playback: { stream, frames: 6, dropped: 2 }
  };
  const after: MoqStatsSample = {
    session, at: 3_000, media: { protocol: 'moqt-18', frameCount: 70, videoBytes: 1_400_000, audioBytes: 0, transportBytesReceived: 1_750_000, relayRttMs: 44 },
    playback: { stream, frames: 62, dropped: 6 }
  };

  expect(summarizeMoqStats('viewer', after, first)).toMatchObject({
    frameRate: 30, renderedFps: 28, droppedFrames: 6, videoMbps: 4, audioMbps: 0, relayMbps: 5, relayRttMs: 44
  });
});

it('omits rates across reconnects and when a counter is unavailable or has reset', () => {
  const first: MoqStatsSample = { session: {}, at: 1_000, media: { protocol: 'moqt-18', frameCount: 90, videoBytes: 500_000 } };
  const retry: MoqStatsSample = { session: {}, at: 2_000, media: { protocol: 'moqt-18', frameCount: 100, videoBytes: 150_000, audioBytes: 1000 } };
  expect(summarizeMoqStats('sender', retry, first).frameRate).toBeUndefined();
  const resumed = summarizeMoqStats('sender', { ...retry, session: first.session }, first);
  expect(resumed.videoMbps).toBeUndefined();
  expect(resumed.audioMbps).toBeUndefined();
});
