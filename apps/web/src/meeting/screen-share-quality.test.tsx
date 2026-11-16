import { SCREEN_SHARE_QUALITY_BODY_LIMIT, ScreenShareQualityReportSchema, type ScreenShareQualityReport } from '@meeting/contracts';
import { Value } from '@sinclair/typebox/value';
import * as nativeCapture from './native-capture.js';
import { describe, expect, it, vi } from 'vitest';
import { ScreenShareQualityRecorder } from './screen-share-quality.js';
import { emptyStats } from './software-media/encoder.js';

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

  it('uploads the native stages using the helper counter interval and omits unchanged snapshots', async () => {
    const upload = vi.fn<(body: ScreenShareQualityReport) => Promise<void>>().mockResolvedValue(undefined);
    const recorder = new ScreenShareQualityRecorder('room', 'sender', Promise.resolve('a'.repeat(32)), upload);
    const track = { muted: false, getSettings: () => ({ frameRate: 60 }) } as unknown as MediaStreamTrack;
    const pacing = { receivedFrames: 60, submittedFrames: 60, refreshFrames: 0, droppedFrames: 0,
      queuedFrames: 0, inFlightFrames: 0, mode: 'worker', scheduler: 'atomics' } as const;
    const first = { at: 500, counters: { type: 'stats', dxgiFrames: 80, filteredFrames: 64, capturedFrames: 63,
      sentFrames: 60, droppedFrames: 3, contentChangedFrames: 59 } } as const;
    const second = { at: 1500, counters: { type: 'stats', dxgiFrames: 180, filteredFrames: 114, capturedFrames: 111,
      sentFrames: 103, droppedFrames: 8, contentChangedFrames: 99 } } as const;
    const stats = vi.spyOn(nativeCapture, 'getNativePacingStats')
      .mockReturnValueOnce({ ...pacing, pipeline: first })
      .mockReturnValue({ ...pacing, receivedFrames: 103, pipeline: second });
    try {
      for (const at of [1000, 2100, 3100]) recorder.sample({ at, mode: 'p2p', links: [], capture: { track, android: false } });
      await recorder.finish();
      const body = upload.mock.calls[0]?.[0];
      expect(Value.Check(ScreenShareQualityReportSchema, JSON.parse(JSON.stringify(body)))).toBe(true);
      expect(body?.samples[0].capture?.native?.pipeline).toBeUndefined();
      expect(body?.samples[1].capture?.native?.pipeline).toEqual({
        intervalMs: 1000, dxgiFps: 100, filteredFps: 50, helperFps: 48, contentChangedFps: 40,
        loopbackSentFps: 43, loopbackDroppedFrames: 5
      });
      expect(body?.samples[2].capture?.native?.pipeline).toBeUndefined();
    } finally { stats.mockRestore(); }
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

  it('uploads both selected ICE types and only aggregate direct-check evidence', async () => {
    const upload = vi.fn<(body: ScreenShareQualityReport) => Promise<void>>().mockResolvedValue(undefined);
    const recorder = new ScreenShareQualityRecorder('room', 'viewer', Promise.resolve('a'.repeat(32)), upload);
    const report = new Map([
      ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'relay-pair' }],
      ['relay-pair', { id: 'relay-pair', type: 'candidate-pair', state: 'succeeded',
        localCandidateId: 'local', remoteCandidateId: 'remote-relay', requestsSent: 40, responsesReceived: 39 }],
      ['direct-pair', { id: 'direct-pair', type: 'candidate-pair', state: 'failed',
        localCandidateId: 'local', remoteCandidateId: 'remote-direct', requestsSent: 7, responsesReceived: 0 }],
      ['local', { id: 'local', type: 'local-candidate', candidateType: 'srflx', address: '192.0.2.1', port: 12345 }],
      ['remote-relay', { id: 'remote-relay', type: 'remote-candidate', candidateType: 'relay', url: 'turn:private' }],
      ['remote-direct', { id: 'remote-direct', type: 'remote-candidate', candidateType: 'host', usernameFragment: 'private-ufrag' }]
    ]) as unknown as RTCStatsReport;
    const ice = { requestedPolicy: 'all', appliedPolicy: 'all', policyReason: 'default', state: 'connected',
      gatheringState: 'complete', ageMs: 750, attemptReason: 'initial',
      localCandidateErrors: 2, remoteCandidateErrors: 1 } as const;
    recorder.sample({ at: 1000, mode: 'turn', links: [{ key: {}, transport: 'turn', report, ice }] });

    await recorder.finish();
    const body = upload.mock.calls[0]?.[0];
    expect(body?.samples[0].links[0].ice).toEqual({
      ...ice, selectedReason: 'relay-pair', localCandidateType: 'srflx', remoteCandidateType: 'relay',
      localDirectCandidates: 1, remoteDirectCandidates: 1, directChecksSent: 7, directResponsesReceived: 0
    });
    expect(Value.Check(ScreenShareQualityReportSchema, JSON.parse(JSON.stringify(body)))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/192\.0\.2\.1|12345|turn:private|private-ufrag|candidateId/i);
  });

  it('keeps a very large diagnostic batch within the upload limit and retains the latest ICE sample', async () => {
    const upload = vi.fn<(body: ScreenShareQualityReport) => Promise<void>>().mockResolvedValue(undefined);
    const recorder = new ScreenShareQualityRecorder('room', 'viewer', Promise.resolve('a'.repeat(32)), upload);
    const keys = Array.from({ length: 5 }, () => ({}));
    const wide = 0.0000012345678901234567;
    const big = 123_456_789_012_345;
    const ice = { requestedPolicy: 'all', appliedPolicy: 'all', policyReason: 'default', state: 'connected',
      gatheringState: 'complete', ageMs: 86_400_000, attemptReason: 'negotiation-timeout',
      lastRetryReason: 'media-stalled', lastRetryAgoMs: 86_400_000,
      localCandidateErrors: 65_535, remoteCandidateErrors: 65_535 } as const;
    const project = { ...emptyStats(), width: big, height: big, rawFps: wide, encodedFps: wide,
      decodedFps: wide, renderedFps: wide, encodeMs: wide, sentBps: big,
      queueDrops: big, expiredDrops: big, droppedFrames: big };
    const encoding = { maxBitrate: big, maxFramerate: wide, scaleResolutionDownBy: wide,
      degradationPreference: 'maintain-resolution' } as const;
    for (let index = 1; index <= 8; index++) {
      const cumulative = big * index;
      const report = new Map([
        ['video', { id: 'video', type: 'inbound-rtp', timestamp: index * 70, kind: 'video', codecId: 'codec',
          frameWidth: big, frameHeight: big, framesPerSecond: wide, framesReceived: cumulative,
          framesDecoded: cumulative, framesDropped: cumulative, framesAssembledFromMultiplePackets: cumulative,
          bytesReceived: cumulative, totalDecodeTime: cumulative, totalAssemblyTime: cumulative,
          freezeCount: cumulative, totalFreezesDuration: 1000 * index, packetsLost: cumulative, packetsReceived: cumulative, jitter: wide,
          jitterBufferDelay: cumulative, jitterBufferEmittedCount: cumulative, powerEfficientDecoder: true,
          nackCount: cumulative, pliCount: cumulative, firCount: cumulative, retransmittedBytesReceived: cumulative }],
        ['codec', { id: 'codec', type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=640028' }],
        ['pair', { id: 'pair', type: 'candidate-pair', selected: true, state: 'succeeded', currentRoundTripTime: wide,
          localCandidateId: 'local', remoteCandidateId: 'remote', availableOutgoingBitrate: big }],
        ['local', { id: 'local', type: 'local-candidate', candidateType: 'relay', relayProtocol: 'udp' }],
        ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'srflx' }]
      ]) as unknown as RTCStatsReport;
      recorder.sample({ at: index * 1000, mode: 'turn', links: keys.map(key => ({ key, transport: 'turn',
        turnProvider: 'coturn', ice, project, encoding, report })) });
    }
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    const body = upload.mock.calls[0][0];
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThanOrEqual(SCREEN_SHARE_QUALITY_BODY_LIMIT);
    expect(body.samples.at(-1)).toMatchObject({ at: 8000, links: [
      { ice: { localCandidateType: 'relay' } }, { ice: { localCandidateType: 'relay' } },
      { ice: { localCandidateType: 'relay' } }, { ice: { localCandidateType: 'relay' } },
      { ice: { localCandidateType: 'relay' } }
    ] });
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
