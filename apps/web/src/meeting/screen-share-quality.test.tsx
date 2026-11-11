import type { ScreenShareQualityReport } from '@meeting/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ScreenShareQualityRecorder } from './screen-share-quality.js';

function report(timestamp: number, frames: number, qpSum: number): RTCStatsReport {
  return new Map([
    ['source', { id: 'source', type: 'media-source', kind: 'video', timestamp, frames }],
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp,
      mediaSourceId: 'source', framesSent: frames / 2, framesEncoded: frames / 2, qpSum }]
  ]) as unknown as RTCStatsReport;
}

describe('screen sharing quality uploads', () => {
  it('uses each connection’s own baseline and omits raw WebRTC identifiers', async () => {
    const upload = vi.fn<(body: ScreenShareQualityReport) => Promise<void>>().mockResolvedValue(undefined);
    const recorder = new ScreenShareQualityRecorder('room', 'sender',
      Promise.resolve('a'.repeat(32)), upload);
    const key = {};
    recorder.sample({ at: 1000, mode: 'p2p', links: [{ key, transport: 'p2p', report: report(1000, 100, 1000) }] });
    recorder.sample({ at: 2000, mode: 'p2p', links: [
      { key, transport: 'p2p', report: report(2000, 160, 2500) },
      { key: {}, transport: 'p2p', report: report(2000, 400, 6000) }
    ] });
    recorder.finish();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const body = upload.mock.calls[0]?.[0];
    expect(body).toMatchObject({ final: true, role: 'sender', samples: [
      { links: [{ link: 1 }] },
      { links: [{ link: 1, rtc: { sourceFps: 60, encodedFps: 30, sentFps: 30, averageQp: 50 } }, { link: 2 }] }
    ] });
    expect(JSON.stringify(body)).not.toMatch(/ssrc|mediaSourceId|candidateUrl|"video"/);
    recorder.sample({ at: 3000, mode: 'p2p', links: [] });
    recorder.finish();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('measures viewer buffering, decoding and playback over the sample interval', async () => {
    const upload = vi.fn<(body: ScreenShareQualityReport) => Promise<void>>().mockResolvedValue(undefined);
    const recorder = new ScreenShareQualityRecorder('room', 'viewer', Promise.resolve('a'.repeat(32)), upload);
    const video = document.createElement('video');
    Object.defineProperty(video, 'getVideoPlaybackQuality', {
      value: vi.fn()
        .mockReturnValueOnce({ totalVideoFrames: 90, droppedVideoFrames: 2 })
        .mockReturnValueOnce({ totalVideoFrames: 110, droppedVideoFrames: 5 })
    });
    const key = {};
    for (const [at, framesDecoded, jitterBufferDelay, freezeCount] of [[1000, 100, 1, 0], [2000, 120, 2, 1]]) {
      const report = new Map([
        ['video', { id: 'video', kind: 'video', type: 'inbound-rtp', timestamp: at,
          framesDecoded, jitterBufferDelay, jitterBufferEmittedCount: framesDecoded, freezeCount }],
        ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local' }],
        ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'udp', url: 'turn:private' }]
      ]) as unknown as RTCStatsReport;
      recorder.sample({ at, mode: 'turn', playback: video, links: [{ key, transport: 'turn', report }] });
    }
    await recorder.finish();
    const body = upload.mock.calls[0]?.[0];
    expect(body?.samples[1]).toMatchObject({
      links: [{ rtc: { decodedFps: 20, jitterBufferMs: 50, freezes: 1, candidateType: 'relay', relayProtocol: 'udp' } }],
      playback: { renderedFps: 17, droppedFrames: 3 }
    });
    expect(JSON.stringify(body)).not.toContain('turn:private');
  });

  it('retries a transiently failed batch with the original sequence while still sampling', async () => {
    const upload = vi.fn<(body: ScreenShareQualityReport) => Promise<void>>()
      .mockRejectedValueOnce(new Error('connection interrupted')).mockResolvedValue(undefined);
    const recorder = new ScreenShareQualityRecorder('room', 'viewer', Promise.resolve('a'.repeat(32)), upload);
    const start = Date.now() - 7000;
    for (let index = 0; index < 8; index++) {
      recorder.sample({ at: start + index * 1000, mode: 'turn', links: [] });
    }
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    recorder.sample({ at: Date.now() + 1000, mode: 'turn', links: [] });
    expect(upload).toHaveBeenCalledTimes(1);
    recorder.sample({ at: Date.now() + 10000, mode: 'turn', links: [] });
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls[1]?.[0]).toEqual(upload.mock.calls[0]?.[0]);

    recorder.finish();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    expect(upload.mock.calls[2]?.[0]).toMatchObject({ final: true, sequence: 1, samples: [{ mode: 'turn' }, { mode: 'turn' }] });
  });

  it('uploads during an active share and retains zero-fps intervals', async () => {
    const upload = vi.fn<(body: ScreenShareQualityReport) => Promise<void>>().mockResolvedValue(undefined);
    const recorder = new ScreenShareQualityRecorder('room', 'sender',
      Promise.resolve('a'.repeat(32)), upload);
    const key = {};
    for (let second = 1; second <= 8; second++) {
      recorder.sample({ at: second * 1000, mode: 'p2p',
        links: [{ key, transport: 'p2p', report: report(second * 1000, 100, 1000) }] });
    }
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0]?.[0]).toMatchObject({ final: false, sequence: 0 });
    expect(upload.mock.calls[0]?.[0]?.samples.at(-1)?.links[0]?.rtc)
      .toMatchObject({ sourceFps: 0, encodedFps: 0, sentFps: 0 });
  });
});
