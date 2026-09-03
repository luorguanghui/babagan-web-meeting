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
        bytesSent: 2_500_000, frameWidth: 432, frameHeight: 270, framesPerSecond: 30
      } as RTCStats]
    ]) as unknown as RTCStatsReport;

    expect(inspectSenderVideoStats(report)).toEqual({
      availableOutgoingBitrateBps: 12_000_000,
      bytesSent: 2_500_000,
      timestamp: 2_000,
      frameWidth: 432,
      frameHeight: 270,
      framesPerSecond: 30
    });
  });

  it('extracts encoder target, send discards, RTT, remote loss, and relay identity', () => {
    const report = new Map<string, RTCStats>([
      ['transport', { id: 'transport', type: 'transport', timestamp: 3_000, selectedCandidatePairId: 'pair' } as RTCStats],
      ['pair', {
        id: 'pair', type: 'candidate-pair', timestamp: 3_000,
        state: 'succeeded', nominated: true, availableOutgoingBitrate: 12_000_000,
        packetsDiscardedOnSend: 42,
        localCandidateId: 'local', remoteCandidateId: 'remote'
      } as RTCStats],
      ['local', {
        id: 'local', type: 'local-candidate', timestamp: 3_000,
        candidateType: 'relay', url: 'turn:turn.cloudflare.com:3478?transport=udp', relayProtocol: 'udp'
      } as RTCStats],
      ['remote', { id: 'remote', type: 'remote-candidate', timestamp: 3_000, candidateType: 'relay' } as RTCStats],
      ['outbound', {
        id: 'outbound', type: 'outbound-rtp', timestamp: 3_000, kind: 'video',
        bytesSent: 2_500_000, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 30,
        targetBitrate: 6_500_000, remoteId: 'remote-inbound'
      } as RTCStats],
      ['remote-inbound', {
        id: 'remote-inbound', type: 'remote-inbound-rtp', timestamp: 3_000, kind: 'video',
        roundTripTime: 0.087, packetsLost: 7, packetsReceived: 12_345
      } as RTCStats]
    ]) as unknown as RTCStatsReport;

    expect(inspectSenderVideoStats(report)).toEqual({
      availableOutgoingBitrateBps: 12_000_000,
      encoderTargetBitrateBps: 6_500_000,
      packetsDiscardedOnSend: 42,
      roundTripTimeMs: 87,
      remotePacketsLost: 7,
      remotePacketsReceived: 12_345,
      selectedLocalCandidateType: 'relay',
      selectedLocalCandidateUrl: 'turn:turn.cloudflare.com:3478?transport=udp',
      selectedRelayProtocol: 'udp',
      bytesSent: 2_500_000,
      timestamp: 3_000,
      frameWidth: 1920,
      frameHeight: 1080,
      framesPerSecond: 30
    });
  });

  it('leaves pressure fields undefined when the report lacks them', () => {
    const report = new Map<string, RTCStats>([
      ['outbound', {
        id: 'outbound', type: 'outbound-rtp', timestamp: 3_000, kind: 'video', bytesSent: 1_000
      } as RTCStats]
    ]) as unknown as RTCStatsReport;

    const stats = inspectSenderVideoStats(report);
    expect(stats.encoderTargetBitrateBps).toBeUndefined();
    expect(stats.packetsDiscardedOnSend).toBeUndefined();
    expect(stats.roundTripTimeMs).toBeUndefined();
    expect(stats.remotePacketsLost).toBeUndefined();
    expect(stats.remotePacketsReceived).toBeUndefined();
    expect(stats.selectedLocalCandidateType).toBeUndefined();
    expect(stats.selectedLocalCandidateUrl).toBeUndefined();
    expect(stats.selectedRelayProtocol).toBeUndefined();
  });
});
