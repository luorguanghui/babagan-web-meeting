import { describe, expect, it } from 'vitest';

import { summarizeWebRtcStats, type WebRtcStatsSnapshot } from './webrtc-stats.js';

function report(values: Record<string, Record<string, unknown>>): RTCStatsReport {
  const entries = Object.entries(values);
  return {
    forEach(callback: (value: RTCStats, key: string, parent: RTCStatsReport) => void) {
      for (const [key, value] of entries) callback(value as unknown as RTCStats, key, this as RTCStatsReport);
    }
  } as RTCStatsReport;
}

describe('WebRTC screen-share statistics', () => {
  it('distinguishes live capture from encoding drops and reports interval encode cost', () => {
    const values = (timestamp: number, framesEncoded: number, totalEncodeTime: number) => report({
      camera: { id: 'camera', type: 'media-source', kind: 'video', framesPerSecond: 30 },
      screen: { id: 'screen', type: 'media-source', kind: 'video', framesPerSecond: 60 },
      video: { id: 'video', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'screen',
        timestamp, framesEncoded, totalEncodeTime, framesPerSecond: 19,
        encoderImplementation: 'ExternalEncoder', powerEfficientEncoder: true }
    });
    const previous = summarizeWebRtcStats([values(1_000, 600, 0.6)]);
    const current = summarizeWebRtcStats([values(2_000, 619, 1.55)], previous);
    expect(current.sender).toMatchObject({
      sourceFramesPerSecond: 60, framesPerSecond: 19,
      averageIntervalEncodeTimeMs: 50, encoderImplementation: 'ExternalEncoder',
      powerEfficientEncoder: true
    });
  });

  it('leaves capture and interval encode measurements absent without supporting stats', () => {
    const current = summarizeWebRtcStats([report({
      video: { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp: 1_000,
        framesEncoded: 60, totalEncodeTime: 0.3 }
    })]);
    expect(current.sender?.sourceFramesPerSecond).toBeUndefined();
    expect(current.sender?.averageIntervalEncodeTimeMs).toBeUndefined();
    expect(current.sender?.powerEfficientEncoder).toBeUndefined();
  });

  it('distinguishes complete-frame arrival from slow decoding during the latest sample', () => {
    const inbound = (timestamp: number, values: Record<string, unknown>) => report({
      video: { id: 'video', type: 'inbound-rtp', kind: 'video', ssrc: 123, timestamp, ...values }
    });
    const previous = summarizeWebRtcStats([inbound(1_000, {
      framesReceived: 600, framesDecoded: 600, totalDecodeTime: 0.6,
      framesAssembledFromMultiplePackets: 600, totalAssemblyTime: 0.6
    })]);
    const current = summarizeWebRtcStats([inbound(3_000, {
      framesReceived: 720, framesDecoded: 634, framesPerSecond: 17, totalDecodeTime: 2.3,
      framesAssembledFromMultiplePackets: 634, totalAssemblyTime: 0.77,
      decoderImplementation: 'FFmpeg', powerEfficientDecoder: false
    })], previous);

    expect(current.receiver).toMatchObject({
      framesPerSecond: 17, receivedFramesPerSecond: 60,
      averageDecodeTimeMs: 50, averageAssemblyTimeMs: 5,
      decoderImplementation: 'FFmpeg', powerEfficientDecoder: false
    });
  });

  it('reports actual sent frame rate independently of encoded frame rate', () => {
    const outbound = (timestamp: number, framesSent: number) => report({
      video: { id: 'video', type: 'outbound-rtp', kind: 'video', ssrc: 123,
        timestamp, framesSent, framesPerSecond: 60 }
    });
    const previous = summarizeWebRtcStats([outbound(1_000, 600)]);
    const current = summarizeWebRtcStats([outbound(3_000, 634)], previous);
    expect(current.sender).toMatchObject({ framesPerSecond: 60, sentFramesPerSecond: 17 });
  });

  it('does not invent receiver measurements before a baseline or without browser support', () => {
    const current = summarizeWebRtcStats([report({
      video: { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 1_000,
        framesReceived: 100, framesDecoded: 100, totalDecodeTime: 5 }
    })]);
    expect(current.receiver?.receivedFramesPerSecond).toBeUndefined();
    expect(current.receiver?.averageDecodeTimeMs).toBeUndefined();
    expect(current.receiver?.decoderImplementation).toBeUndefined();
    expect(current.receiver?.powerEfficientDecoder).toBeUndefined();
  });

  it.each(['stream', 'reset', 'timestamp', 'unsupported'])(
    'discards interval receiver measurements after %s changes', (change) => {
      const values = { id: 'video', type: 'inbound-rtp', kind: 'video', ssrc: 123,
        timestamp: 1_000, framesReceived: 100, framesDecoded: 100, totalDecodeTime: 1 };
      const previous = summarizeWebRtcStats([report({ video: values })]);
      const next: Record<string, unknown> = { ...values, timestamp: 2_000,
        framesReceived: 160, framesDecoded: 160, totalDecodeTime: 2 };
      if (change === 'stream') next.ssrc = 456;
      if (change === 'reset') Object.assign(next, { framesReceived: 0, framesDecoded: 0, totalDecodeTime: 0 });
      if (change === 'timestamp') next.timestamp = 1_000;
      if (change === 'unsupported') {
        delete next.framesReceived;
        delete next.totalDecodeTime;
      }
      const current = summarizeWebRtcStats([report({ video: next })], previous);
      expect(current.receiver?.receivedFramesPerSecond).toBeUndefined();
      expect(current.receiver?.averageDecodeTimeMs).toBeUndefined();
    }
  );

  it('reports zero complete frames during a stall without dividing by zero for decode time', () => {
    const values = { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 1_000,
      framesReceived: 100, framesDecoded: 100, totalDecodeTime: 1 };
    const previous = summarizeWebRtcStats([report({ video: values })]);
    const current = summarizeWebRtcStats([report({ video: { ...values, timestamp: 2_000 } })], previous);
    expect(current.receiver?.receivedFramesPerSecond).toBe(0);
    expect(current.receiver?.averageDecodeTimeMs).toBeUndefined();
  });

  it('derives sender codec, rate, frame, loss, RTT and encoder pressure', () => {
    const previous: WebRtcStatsSnapshot = {
      sampledAt: 1_000,
      counters: { outbound: { bytes: 1_000_000, timestamp: 1_000 } }
    };
    const current = summarizeWebRtcStats([report({
      codec: { id: 'codec', type: 'codec', mimeType: 'video/H264' },
      outbound: {
        id: 'outbound', type: 'outbound-rtp', kind: 'video', codecId: 'codec', timestamp: 2_000,
        bytesSent: 2_250_000, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60,
        framesEncoded: 120, framesSent: 118, totalEncodeTime: 1.2,
        qualityLimitationReason: 'bandwidth', nackCount: 4, pliCount: 2, firCount: 1,
        retransmittedBytesSent: 20_000, targetBitrate: 6_500_000
      },
      remote: { id: 'remote', type: 'remote-inbound-rtp', kind: 'video', packetsLost: 6, roundTripTime: 0.08 },
      pair: {
        id: 'pair', type: 'candidate-pair', nominated: true, state: 'succeeded',
        availableOutgoingBitrate: 12_000_000, packetsDiscardedOnSend: 3, localCandidateId: 'local'
      },
      local: {
        id: 'local', type: 'local-candidate', candidateType: 'relay',
        url: 'turn:turn.cloudflare.com:443?transport=tcp', relayProtocol: 'tcp'
      }
    })], previous, 2_000);

    expect(current.sender).toMatchObject({
      codec: 'H264', width: 1920, height: 1080, framesPerSecond: 60,
      bitrateMbps: 10, framesEncoded: 120, framesSent: 118, averageEncodeTimeMs: 10,
      qualityLimitationReason: 'bandwidth', packetsLost: 6, roundTripTimeMs: 80,
      // The RTC estimate and the encoder's own target stay distinct fields.
      availableOutgoingBitrateMbps: 12, encoderTargetBitrateMbps: 6.5,
      selectedCandidateType: 'relay', selectedCandidateUrl: 'turn:turn.cloudflare.com:443?transport=tcp',
      relayProtocol: 'tcp', packetsDiscardedOnSend: 3,
      nackCount: 4, pliCount: 2, firCount: 1
    });
  });

  it('derives receiver bitrate, freezes, jitter buffer and dropped frames', () => {
    const previous: WebRtcStatsSnapshot = {
      sampledAt: 1_000,
      counters: { inbound: { bytes: 500_000, timestamp: 1_000 } }
    };
    const current = summarizeWebRtcStats([report({
      codec: { id: 'codec', type: 'codec', mimeType: 'video/VP8' },
      inbound: {
        id: 'inbound', type: 'inbound-rtp', kind: 'video', codecId: 'codec', timestamp: 2_000,
        bytesReceived: 1_500_000, frameWidth: 1280, frameHeight: 720, framesPerSecond: 57,
        framesDecoded: 100, framesDropped: 3, freezeCount: 2, jitter: 0.012,
        jitterBufferDelay: 1.5, jitterBufferEmittedCount: 100, packetsLost: 5, nackCount: 7, pliCount: 3
      }
    })], previous, 2_000);

    expect(current.receiver).toMatchObject({
      codec: 'VP8', width: 1280, height: 720, framesPerSecond: 57, bitrateMbps: 8,
      framesDecoded: 100, framesDropped: 3, freezeCount: 2, jitterMs: 12,
      averageJitterBufferDelayMs: 15, packetsLost: 5, nackCount: 7, pliCount: 3
    });
  });

  it('keeps media and candidate-pair diagnostics on the same peer connection', () => {
    const first = report({
      outbound: {
        id: 'outbound', type: 'outbound-rtp', kind: 'video',
        timestamp: 2_000, bytesSent: 1_000_000
      },
      transport: {
        id: 'transport', type: 'transport', selectedCandidatePairId: 'pair'
      },
      pair: {
        id: 'pair', type: 'candidate-pair', state: 'succeeded',
        localCandidateId: 'local', availableOutgoingBitrate: 3_000_000
      },
      local: {
        id: 'local', type: 'local-candidate', candidateType: 'relay',
        url: 'turn:turn.cloudflare.com:3478?transport=udp'
      }
    });
    const second = report({
      outbound: {
        id: 'outbound', type: 'outbound-rtp', kind: 'video',
        timestamp: 2_000, bytesSent: 9_000_000
      },
      transport: {
        id: 'transport', type: 'transport', selectedCandidatePairId: 'pair'
      },
      pair: {
        id: 'pair', type: 'candidate-pair', state: 'succeeded',
        localCandidateId: 'local', availableOutgoingBitrate: 20_000_000
      },
      local: {
        id: 'local', type: 'local-candidate', candidateType: 'host'
      }
    });

    const current = summarizeWebRtcStats([first, second], undefined, 2_000);

    expect(current.sender?.availableOutgoingBitrateMbps).toBe(3);
    expect(current.sender?.selectedCandidateType).toBe('relay');
    expect(current.sender?.selectedCandidateUrl).toBe('turn:turn.cloudflare.com:3478?transport=udp');
  });
});
