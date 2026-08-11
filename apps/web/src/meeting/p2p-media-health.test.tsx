import { describe, expect, it } from 'vitest';

import { inspectP2pMediaHealth } from './p2p-media-health.js';

function report(candidateType: RTCIceCandidateType, bytesReceived = 1_200, framesDecoded = 3): RTCStatsReport {
  return new Map<string, RTCStats>([
    ['transport', { id: 'transport', type: 'transport', timestamp: 1, selectedCandidatePairId: 'pair' } as RTCStats],
    ['pair', {
      id: 'pair', type: 'candidate-pair', timestamp: 1, state: 'succeeded',
      localCandidateId: 'local', remoteCandidateId: 'remote'
    } as RTCStats],
    ['local', { id: 'local', type: 'local-candidate', timestamp: 1, candidateType } as RTCStats],
    ['remote', { id: 'remote', type: 'remote-candidate', timestamp: 1, candidateType: 'host' } as RTCStats],
    ['video', {
      id: 'video', type: 'inbound-rtp', timestamp: 1, kind: 'video',
      bytesReceived, framesDecoded
    } as RTCStats]
  ]) as unknown as RTCStatsReport;
}

describe('inspectP2pMediaHealth', () => {
  it('returns direct video counters for a non-relay selected pair', () => {
    expect(inspectP2pMediaHealth(report('srflx'))).toEqual({
      direct: true,
      bytesReceived: 1_200,
      framesDecoded: 3
    });
  });

  it('rejects a relay pair even when media counters are growing', () => {
    expect(inspectP2pMediaHealth(report('relay')).direct).toBe(false);
  });

  it('requires a selected pair and video inbound RTP', () => {
    expect(inspectP2pMediaHealth(new Map() as unknown as RTCStatsReport)).toEqual({
      direct: false,
      bytesReceived: 0,
      framesDecoded: 0
    });
  });
});
