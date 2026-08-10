import { describe, expect, it, vi } from 'vitest';

import { createP2pStatsCollector, type P2pStatsReport } from './p2p-stats.js';
import type { WebRtcMediaStats, WebRtcStatsSnapshot } from './webrtc-stats.js';

describe('anonymous P2P quality statistics', () => {
  it('counts sharer-side attempts, successes, fallbacks and the average setup time', () => {
    const collector = createP2pStatsCollector({
      slug: 'meeting-slug', sessionId: 'anon-session-1',
      now: () => 0, sendReport: async () => undefined
    });

    collector.observeShareStates(new Map([['viewer-1', 'negotiating']]), 1_000);
    // viewer-1 establishes (1s setup); viewer-2 starts negotiating and falls back.
    collector.observeShareStates(new Map([
      ['viewer-1', 'p2p'],
      ['viewer-2', 'negotiating']
    ]), 2_000);
    collector.observeShareStates(new Map([
      ['viewer-1', 'p2p'],
      ['viewer-2', 'livekit-fallback']
    ]), 2_800);
    // viewer-2 re-attempts after the fallback and establishes (500ms setup).
    collector.observeShareStates(new Map([
      ['viewer-1', 'p2p'],
      ['viewer-2', 'negotiating']
    ]), 3_000);
    collector.observeShareStates(new Map([
      ['viewer-1', 'p2p'],
      ['viewer-2', 'p2p']
    ]), 3_500);

    expect(collector.reportPayload()).toEqual({
      sessionId: 'anon-session-1',
      attempts: 3,
      p2pSucceeded: 2,
      fallbacks: 1,
      avgSetupMs: 750,
      avgRttMs: 0,
      maxLossPct: 0
    });
  });

  it('counts an established session that later falls back as both a success and a fallback', () => {
    const collector = createP2pStatsCollector({
      slug: 'meeting-slug', sessionId: 'anon-session-1',
      now: () => 0, sendReport: async () => undefined
    });

    collector.observeShareStates(new Map([['viewer-1', 'negotiating']]), 0);
    collector.observeShareStates(new Map([['viewer-1', 'p2p']]), 500);
    collector.observeShareStates(new Map([['viewer-1', 'livekit-fallback']]), 900);

    expect(collector.reportPayload()).toMatchObject({
      attempts: 1, p2pSucceeded: 1, fallbacks: 1, avgSetupMs: 500
    });
  });

  it('counts a persistent fallback state only once across snapshots emitted for other viewers', () => {
    const collector = createP2pStatsCollector({
      slug: 'meeting-slug', sessionId: 'anon-session-1',
      now: () => 0, sendReport: async () => undefined
    });

    // The share controller emits the full viewer map on every transition of
    // any viewer, and `livekit-fallback` persists until that viewer leaves or
    // retries — repeated snapshots must not re-count the same fallback.
    collector.observeShareStates(new Map([
      ['viewer-1', 'negotiating'],
      ['viewer-2', 'negotiating']
    ]), 1_000);
    collector.observeShareStates(new Map([
      ['viewer-1', 'negotiating'],
      ['viewer-2', 'livekit-fallback']
    ]), 2_000);
    collector.observeShareStates(new Map([
      ['viewer-1', 'p2p'],
      ['viewer-2', 'livekit-fallback']
    ]), 2_500);
    collector.observeShareStates(new Map([
      ['viewer-1', 'livekit-fallback'],
      ['viewer-2', 'livekit-fallback']
    ]), 3_000);

    expect(collector.reportPayload()).toMatchObject({
      attempts: 2, p2pSucceeded: 1, fallbacks: 2
    });
  });

  it('counts a fallback edge again after the viewer rebuilt its session', () => {
    const collector = createP2pStatsCollector({
      slug: 'meeting-slug', sessionId: 'anon-session-1',
      now: () => 0, sendReport: async () => undefined
    });

    collector.observeShareStates(new Map([['viewer-1', 'negotiating']]), 1_000);
    collector.observeShareStates(new Map([['viewer-1', 'livekit-fallback']]), 1_500);
    collector.observeShareStates(new Map([['viewer-1', 'negotiating']]), 2_000); // rebuilt
    collector.observeShareStates(new Map([['viewer-1', 'livekit-fallback']]), 2_500);

    expect(collector.reportPayload()).toMatchObject({
      attempts: 2, p2pSucceeded: 0, fallbacks: 2
    });
  });

  it('counts viewer-side establishment the same way, resetting on idle', () => {
    const collector = createP2pStatsCollector({
      slug: 'meeting-slug', sessionId: 'anon-session-1',
      now: () => 0, sendReport: async () => undefined
    });

    collector.observeViewerState('negotiating', 1_000);
    collector.observeViewerState('p2p', 2_000);
    collector.observeViewerState('idle', 2_500); // share session closed
    collector.observeViewerState('negotiating', 3_000);
    collector.observeViewerState('livekit', 3_400); // no media within the timeout

    expect(collector.reportPayload()).toMatchObject({
      attempts: 2, p2pSucceeded: 1, fallbacks: 1, avgSetupMs: 1_000
    });
  });

  it('averages RTT samples and keeps the maximum loss percentage from the stats data source', () => {
    const collector = createP2pStatsCollector({
      slug: 'meeting-slug', sessionId: 'anon-session-1',
      now: () => 0, sendReport: async () => undefined
    });

    collector.observeQuality(snapshot({ roundTripTimeMs: 40, packetsLost: 1, packetsReceived: 99 }));
    collector.observeQuality(snapshot(undefined, { packetsLost: 5, packetsReceived: 95 }));
    collector.observeQuality(snapshot({ roundTripTimeMs: 80 }));
    collector.observeQuality(snapshot({ packetsLost: 10, packetsReceived: 90 }));

    expect(collector.reportPayload()).toMatchObject({ avgRttMs: 60, maxLossPct: 10 });
  });

  it('reports exactly one anonymous payload and stays silent on transport failures', async () => {
    const sendReport = vi.fn(async () => { throw new Error('offline'); });
    const collector = createP2pStatsCollector({
      slug: 'meeting-slug', sessionId: 'anon-session-1',
      now: () => 0, sendReport
    });
    collector.observeShareStates(new Map([['viewer-1', 'negotiating']]), 100);
    collector.observeShareStates(new Map([['viewer-1', 'p2p']]), 400);

    await expect(collector.report()).resolves.toBeUndefined();
    await expect(collector.report()).resolves.toBeUndefined();

    expect(sendReport).toHaveBeenCalledOnce();
    expect(sendReport).toHaveBeenCalledWith({
      sessionId: 'anon-session-1',
      attempts: 1,
      p2pSucceeded: 1,
      fallbacks: 0,
      avgSetupMs: 300,
      avgRttMs: 0,
      maxLossPct: 0
    } satisfies P2pStatsReport);
  });

  it('reports zeros when nothing was observed', async () => {
    const sendReport = vi.fn(async () => undefined);
    const collector = createP2pStatsCollector({
      slug: 'meeting-slug', sessionId: 'anon-session-1', sendReport
    });

    await collector.report();

    expect(sendReport).toHaveBeenCalledWith({
      sessionId: 'anon-session-1',
      attempts: 0,
      p2pSucceeded: 0,
      fallbacks: 0,
      avgSetupMs: 0,
      avgRttMs: 0,
      maxLossPct: 0
    } satisfies P2pStatsReport);
  });
});

function snapshot(
  sender?: Partial<WebRtcMediaStats>,
  receiver?: Partial<WebRtcMediaStats>
): WebRtcStatsSnapshot {
  return {
    sampledAt: 1,
    ...(sender ? { sender } : {}),
    ...(receiver ? { receiver } : {}),
    counters: {}
  };
}
