import { describe, expect, it } from 'vitest';

import { inspectP2pMediaHealth, inspectSenderVideoStats } from './p2p-media-health.js';

function report(
  localCandidateType: RTCIceCandidateType,
  remoteCandidateType: RTCIceCandidateType = 'host',
  bytesReceived = 1_200,
  framesDecoded = 3,
  packetsReceived = 80,
  packetsLost = 12,
  freezeCount = 2
): RTCStatsReport {
  return new Map<string, RTCStats>([
    ['transport', { id: 'transport', type: 'transport', timestamp: 1, selectedCandidatePairId: 'pair' } as RTCStats],
    ['pair', {
      id: 'pair', type: 'candidate-pair', timestamp: 1, state: 'succeeded',
      localCandidateId: 'local', remoteCandidateId: 'remote'
    } as RTCStats],
    ['local', { id: 'local', type: 'local-candidate', timestamp: 1, candidateType: localCandidateType } as RTCStats],
    ['remote', { id: 'remote', type: 'remote-candidate', timestamp: 1, candidateType: remoteCandidateType } as RTCStats],
    ['video', {
      id: 'video', type: 'inbound-rtp', timestamp: 1, kind: 'video',
      bytesReceived, framesDecoded, packetsReceived, packetsLost, freezeCount
    } as RTCStats]
  ]) as unknown as RTCStatsReport;
}

describe('inspectP2pMediaHealth', () => {
  it('returns direct video counters for a non-relay selected pair', () => {
    expect(inspectP2pMediaHealth(report('srflx'))).toEqual({
      path: 'direct',
      bytesReceived: 1_200,
      framesDecoded: 3,
      packetsReceived: 80,
      packetsLost: 12,
      freezeCount: 2
    });
  });

  it.each([
    ['local', 'relay', 'host'],
    ['remote', 'srflx', 'relay']
  ] as const)('classifies a %s relay candidate as TURN relay', (_side, local, remote) => {
    expect(inspectP2pMediaHealth(report(local, remote)).path).toBe('relay');
  });

  it('leaves the path unknown until a selected pair and both candidates exist', () => {
    expect(inspectP2pMediaHealth(new Map() as unknown as RTCStatsReport)).toEqual({
      path: 'unknown',
      bytesReceived: 0,
      framesDecoded: 0,
      packetsReceived: 0,
      packetsLost: 0,
      freezeCount: 0
    });
  });
});

describe('inspectSenderVideoStats', () => {
  it('returns relay capacity and outbound counters for adaptive encoding', () => {
    const report = new Map<string, RTCStats>([
      ['transport', { id: 'transport', type: 'transport', timestamp: 2_000, selectedCandidatePairId: 'pair' } as RTCStats],
      ['pair', {
        id: 'pair', type: 'candidate-pair', timestamp: 2_000,
        state: 'succeeded', nominated: true, availableOutgoingBitrate: 12_000_000
      } as RTCStats],
      ['outbound', {
        id: 'outbound', type: 'outbound-rtp', timestamp: 2_000, kind: 'video',
        bytesSent: 2_500_000, framesPerSecond: 30
      } as RTCStats]
    ]) as unknown as RTCStatsReport;

    expect(inspectSenderVideoStats(report)).toEqual({
      availableOutgoingBitrateBps: 12_000_000,
      bytesSent: 2_500_000,
      timestamp: 2_000,
      framesPerSecond: 30
    });
  });
});
