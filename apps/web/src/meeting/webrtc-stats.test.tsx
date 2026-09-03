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
        availableOutgoingBitrate: 12_000_000, localCandidateId: 'local'
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
      relayProtocol: 'tcp',
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
});
