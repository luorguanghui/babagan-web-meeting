import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  P2P_ICE_DISCONNECT_TIMEOUT_MS,
  P2P_ICE_NEGOTIATION_TIMEOUT_MS,
  P2P_RTP_STALL_TIMEOUT_MS
} from '@meeting/contracts';

import {
  P2pViewerController,
  type P2pViewerSignaling,
  type ViewerP2pState
} from './p2p-viewer-controller.js';

const iceServers: RTCIceServer[] = [{ urls: ['stun:stun.example.test:3478'] }];

let pcCounter = 0;

class FakeTrack {
  kind: 'video' | 'audio';
  muted = true;
  onunmute: (() => void) | null = null;

  constructor(kind: 'video' | 'audio') {
    this.kind = kind;
  }

  unmute(): void {
    this.muted = false;
    this.onunmute?.();
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  readonly id = pcCounter++;
  readonly config: RTCConfiguration;
  readonly remoteDescriptions: RTCSessionDescriptionInit[] = [];
  readonly localDescriptions: RTCSessionDescriptionInit[] = [];
  readonly addedIceCandidates: Array<RTCIceCandidateInit | undefined> = [];
  closed = false;
  failRemoteDescription = false;
  /** Test hook: a pending promise that parks the matching in-flight operation. */
  setRemoteDescriptionGate?: Promise<void>;
  iceConnectionState: RTCIceConnectionState = 'new';
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  statsCandidateType: RTCIceCandidateType = 'srflx';
  statsBytes = 1_200;
  statsFrames = 3;
  statsPacketsReceived = 80;
  statsPacketsLost = 0;
  statsFreezeCount = 0;
  autoProgress = true;
  /** When true, getStats omits the transport/pair/candidate entries (path 'unknown'). */
  statsOmitPair = false;
  readonly setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    if (this.failRemoteDescription) throw new Error('bad sdp');
    if (this.setRemoteDescriptionGate) await this.setRemoteDescriptionGate;
    this.remoteDescriptions.push(description);
  });
  readonly createAnswer = vi.fn(async () => ({ type: 'answer', sdp: `answer-${this.id}` }));
  readonly setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescriptions.push(description);
  });
  readonly addIceCandidate = vi.fn(async (candidate?: RTCIceCandidateInit | RTCIceCandidate) => {
    this.addedIceCandidates.push(candidate === undefined ? undefined : (candidate as RTCIceCandidateInit));
  });
  readonly getStats = vi.fn(async () => {
    const report = this.statsOmitPair
      ? new Map<string, RTCStats>([
        ['video', {
          id: 'video', type: 'inbound-rtp', timestamp: 1, kind: 'video',
          bytesReceived: this.statsBytes, framesDecoded: this.statsFrames,
          packetsReceived: this.statsPacketsReceived, packetsLost: this.statsPacketsLost,
          freezeCount: this.statsFreezeCount
        } as RTCStats]
      ]) as unknown as RTCStatsReport
      : statsReport(this.statsCandidateType, this.statsBytes, this.statsFrames, {
        packetsReceived: this.statsPacketsReceived,
        packetsLost: this.statsPacketsLost,
        freezeCount: this.statsFreezeCount
      });
    if (this.autoProgress) {
      this.statsBytes += 1_000;
      this.statsFrames += 1;
    }
    return report;
  });

  constructor(config: RTCConfiguration) {
    this.config = config;
    FakeRTCPeerConnection.instances.push(this);
  }

  get remoteDescription(): RTCSessionDescription | null {
    return (this.remoteDescriptions[this.remoteDescriptions.length - 1] ?? null) as RTCSessionDescription | null;
  }

  close(): void {
    this.closed = true;
    this.iceConnectionState = 'closed';
    this.oniceconnectionstatechange?.();
  }

  setIceConnectionState(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }

  fireTrack(kind: 'video' | 'audio', stream: MediaStream, track = new FakeTrack(kind)): FakeTrack {
    this.ontrack?.({ track, streams: [stream] } as unknown as RTCTrackEvent);
    return track;
  }
}

function statsReport(
  candidateType: RTCIceCandidateType,
  bytesReceived: number,
  framesDecoded: number,
  counters: { packetsReceived: number; packetsLost: number; freezeCount: number }
): RTCStatsReport {
  return new Map<string, RTCStats>([
    ['transport', { id: 'transport', type: 'transport', timestamp: 1, selectedCandidatePairId: 'pair' } as RTCStats],
    ['pair', {
      id: 'pair', type: 'candidate-pair', timestamp: 1, state: 'succeeded',
      localCandidateId: 'local', remoteCandidateId: 'remote'
    } as RTCStats],
    ['local', { id: 'local', type: 'local-candidate', timestamp: 1, candidateType } as RTCStats],
    ['remote', { id: 'remote', type: 'remote-candidate', timestamp: 1, candidateType: 'host' } as RTCStats],
    ['video', {
      id: 'video', type: 'inbound-rtp', timestamp: 1, kind: 'video', bytesReceived, framesDecoded,
      ...counters
    } as RTCStats]
  ]) as unknown as RTCStatsReport;
}

function makeStream(): MediaStream {
  return {} as unknown as MediaStream;
}

function makeCandidate(raw: string, sdpMid = '0', sdpMLineIndex = 0): RTCPeerConnectionIceEvent {
  return {
    candidate: {
      toJSON: () => ({ candidate: raw, sdpMid, sdpMLineIndex, usernameFragment: 'ufrag' })
    }
  } as unknown as RTCPeerConnectionIceEvent;
}

function makeHarness(options: {
  onPcCreated?: (pc: FakeRTCPeerConnection) => void;
  onFallbackRequested?: (complete: () => void) => void;
  now?: () => number;
} = {}) {
  let healthCheck: (() => Promise<void>) | undefined;
  const signaling: P2pViewerSignaling = {
    sendAnswer: vi.fn(), sendIce: vi.fn(), sendMediaReady: vi.fn(), sendRetry: vi.fn(), sendBye: vi.fn()
  };
  const onFallback = vi.fn();
  const controller = new P2pViewerController(signaling, iceServers, {
    createPeerConnection: (servers) => {
      const pc = new FakeRTCPeerConnection({ iceServers: servers });
      options.onPcCreated?.(pc);
      return pc as unknown as RTCPeerConnection;
    },
    onFallback,
    onFallbackRequested: options.onFallbackRequested,
    healthSampleIntervalMs: 1_000,
    now: options.now,
    scheduleHealthChecks: (check) => {
      healthCheck = check;
      return () => undefined;
    }
  });
  return {
    controller,
    signaling,
    onFallback,
    async runHealthCheck() {
      if (!healthCheck) throw new Error('health check was not scheduled');
      await healthCheck();
    }
  };
}

beforeEach(() => {
  FakeRTCPeerConnection.instances = [];
  pcCounter = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('p2p viewer controller', () => {
  it('answers the sharer offer: remote description, local answer, and a negotiating state', async () => {
    const { controller, signaling } = makeHarness();

    await controller.acceptOffer('sharer-1', 'offer-sdp');

    const pc = FakeRTCPeerConnection.instances[0];
    expect(pc.config).toEqual({ iceServers });
    expect(pc.remoteDescriptions).toEqual([{ type: 'offer', sdp: 'offer-sdp' }]);
    expect(pc.createAnswer).toHaveBeenCalledOnce();
    expect(pc.localDescriptions).toEqual([{ type: 'answer', sdp: 'answer-0' }]);
    expect(signaling.sendAnswer).toHaveBeenCalledOnce();
    expect(signaling.sendAnswer).toHaveBeenCalledWith('sharer-1', 'answer-0');
    expect(controller.getState()).toBe('negotiating');
    expect(controller.getStream()).toBeNull();
  });

  it('ignores offers from anyone else once a sharer is established', async () => {
    const { controller, signaling } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];

    await controller.acceptOffer('stranger', 'evil-offer');

    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
    expect(pc.closed).toBe(false);
    expect(signaling.sendAnswer).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toBe('negotiating');
  });

  it('treats a new offer from the same sharer as renegotiation and rebuilds the session', async () => {
    const { controller, signaling } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-1');
    const first = FakeRTCPeerConnection.instances[0];
    const stream = makeStream();
    const videoTrack = first.fireTrack('video', stream);
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getState()).toBe('p2p');
    expect(signaling.sendMediaReady).toHaveBeenCalledWith('sharer-1');

    await controller.acceptOffer('sharer-1', 'offer-2');

    expect(first.closed).toBe(true);
    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    const second = FakeRTCPeerConnection.instances[1];
    expect(second.remoteDescriptions).toEqual([{ type: 'offer', sdp: 'offer-2' }]);
    expect(signaling.sendAnswer).toHaveBeenCalledTimes(2);
    expect(signaling.sendAnswer).toHaveBeenLastCalledWith('sharer-1', 'answer-1');
    expect(controller.getState()).toBe('negotiating');
    expect(controller.getStream()).toBeNull(); // old stream dropped with the old session
  });

  it('renegotiates even from the livekit state when a fresh offer arrives', async () => {
    const { controller, signaling, onFallback } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-1');
    vi.advanceTimersByTime(P2P_ICE_NEGOTIATION_TIMEOUT_MS);
    expect(controller.getState()).toBe('livekit');
    expect(onFallback).toHaveBeenCalledOnce();

    await controller.acceptOffer('sharer-1', 'offer-2');

    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    expect(FakeRTCPeerConnection.instances[1].closed).toBe(false);
    expect(signaling.sendAnswer).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toBe('negotiating');
  });

  it('queues remote candidates until the remote description is applied, then flushes them in order', async () => {
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
    const { controller } = makeHarness({
      onPcCreated: (pc) => { pc.setRemoteDescriptionGate = gate; }
    });

    const acceptPromise = controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    await controller.handleIce('sharer-1', JSON.stringify({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }));
    await controller.handleIce('sharer-1', JSON.stringify({ candidate: 'candidate:2', sdpMid: '1', sdpMLineIndex: 1 }));
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    resolveGate();
    await acceptPromise;

    expect(pc.addIceCandidate).toHaveBeenCalledTimes(2);
    expect(pc.addIceCandidate).toHaveBeenNthCalledWith(1, { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
    expect(pc.addIceCandidate).toHaveBeenNthCalledWith(2, { candidate: 'candidate:2', sdpMid: '1', sdpMLineIndex: 1 });

    await controller.handleIce('sharer-1', JSON.stringify({ candidate: 'candidate:3', sdpMid: '0', sdpMLineIndex: 0 }));
    expect(pc.addIceCandidate).toHaveBeenCalledTimes(3);
  });

  it('applies end-of-candidates and bare-string candidates after the answer', async () => {
    const { controller } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];

    await controller.handleIce('sharer-1', null);
    await controller.handleIce('sharer-1', 'candidate:99 1 udp 1 1.2.3.4 99 typ host');

    expect(pc.addIceCandidate).toHaveBeenCalledTimes(2);
    expect(pc.addIceCandidate).toHaveBeenNthCalledWith(1, undefined); // end-of-candidates
    expect(pc.addIceCandidate).toHaveBeenNthCalledWith(2, { candidate: 'candidate:99 1 udp 1 1.2.3.4 99 typ host' });
  });

  it('ignores candidates from anyone other than the sharer', async () => {
    const { controller } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];

    await controller.handleIce('stranger', JSON.stringify({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }));

    expect(pc.addIceCandidate).not.toHaveBeenCalled();
  });

  it('forwards local trickle candidates and end-of-candidates to signaling in the shared wire format', async () => {
    const { controller, signaling } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];

    pc.onicecandidate?.(makeCandidate('candidate:1 1 udp 2122260223 1.2.3.4 5000 typ host'));
    expect(signaling.sendIce).toHaveBeenLastCalledWith(
      'sharer-1',
      JSON.stringify({ candidate: 'candidate:1 1 udp 2122260223 1.2.3.4 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ufrag' })
    );

    pc.onicecandidate?.({ candidate: null } as unknown as RTCPeerConnectionIceEvent);
    expect(signaling.sendIce).toHaveBeenLastCalledWith('sharer-1', null);
  });

  it('collects the ontrack stream and transitions to p2p once video media arrives', async () => {
    const { controller, signaling } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    const stream = makeStream();

    const videoTrack = pc.fireTrack('video', stream);
    const audioTrack = pc.fireTrack('audio', stream);
    expect(controller.getStream()).toBe(stream);
    expect(controller.getState()).toBe('negotiating'); // muted: no RTP yet

    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getState()).toBe('p2p');
    expect(audioTrack.muted).toBe(true); // audio alone does not count as media

    vi.advanceTimersByTime(60_000);
    expect(controller.getState()).toBe('p2p');
    expect(signaling.sendBye).not.toHaveBeenCalled();
  });

  it('treats a video track that is already unmuted at ontrack as media received', async () => {
    const { controller } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    const liveTrack = new FakeTrack('video');
    liveTrack.muted = false;

    pc.fireTrack('video', makeStream(), liveTrack);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(controller.getState()).toBe('p2p');
  });

  it('keeps the existing state when decoded media has an unclassifiable path', async () => {
    // getStats can transiently lack the selected pair or its candidate stats
    // (path 'unknown') even while RTP is flowing. Media that decodes is the
    // success signal; the missing classification must neither guess P2P nor
    // force an SFU fallback.
    const { controller, signaling } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsOmitPair = true;
    const videoTrack = pc.fireTrack('video', makeStream());
    videoTrack.unmute();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getState()).toBe('negotiating');
    expect(signaling.sendMediaReady).toHaveBeenCalledWith('sharer-1');

    // Decoded media cancels the no-media timer even while the selected pair is
    // temporarily unavailable.
    vi.advanceTimersByTime(P2P_ICE_NEGOTIATION_TIMEOUT_MS + 1);
    expect(controller.getState()).toBe('negotiating');
    expect(signaling.sendBye).not.toHaveBeenCalled();
  });

  it('retains a candidate that arrives immediately before its offer', async () => {
    const { controller } = makeHarness();

    await controller.handleIce('sharer-1', JSON.stringify({
      candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0
    }));
    await controller.acceptOffer('sharer-1', 'offer-sdp');

    const pc = FakeRTCPeerConnection.instances[0];
    expect(pc.addIceCandidate).toHaveBeenCalledWith({
      candidate: 'candidate:early', sdpMid: '0', sdpMLineIndex: 0
    });
  });

  it('ignores candidates from an older offer generation after renegotiation', async () => {
    const { controller } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-1', 'generation-1');
    await controller.acceptOffer('sharer-1', 'offer-2', 'generation-2');
    const pc = FakeRTCPeerConnection.instances.at(-1)!;

    await controller.handleIce('sharer-1', JSON.stringify({ candidate: 'old-candidate' }), 'generation-1');
    await controller.handleIce('sharer-1', JSON.stringify({ candidate: 'new-candidate' }), 'generation-2');

    expect(pc.addedIceCandidates).toEqual([{ candidate: 'new-candidate' }]);
  });

  it('asks the sharer to re-drive a fresh offer on requestRetry', async () => {
    const { controller, signaling } = makeHarness();
    expect(controller.requestRetry()).toBeUndefined();
    expect(signaling.sendRetry).not.toHaveBeenCalled();

    await controller.acceptOffer('sharer-1', 'offer-sdp');
    controller.requestRetry();
    expect(signaling.sendRetry).toHaveBeenCalledWith('sharer-1');

    controller.close();
    controller.requestRetry();
    expect(signaling.sendRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps healthy relay media and reports the TURN transport state', async () => {
    const { controller, signaling } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    const videoTrack = pc.fireTrack('video', makeStream());
    videoTrack.unmute();

    await vi.advanceTimersByTimeAsync(1_000);

    // A relayed session stays on the TURN path: coturn forwards UDP at kernel
    // level, which measured smoother than the SFU on the small 2-core host.
    expect(controller.getState()).toBe('turn');
    expect(signaling.sendMediaReady).toHaveBeenCalledWith('sharer-1');
  });

  it('tracks selected-pair migration from direct to relay and back to direct', async () => {
    const { controller, runHealthCheck } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    const videoTrack = pc.fireTrack('video', makeStream());
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getState()).toBe('p2p');

    pc.statsCandidateType = 'relay';
    await runHealthCheck();
    expect(controller.getState()).toBe('turn');

    pc.statsOmitPair = true;
    await runHealthCheck();
    expect(controller.getState()).toBe('turn');

    pc.statsOmitPair = false;
    pc.statsCandidateType = 'srflx';
    await runHealthCheck();
    expect(controller.getState()).toBe('p2p');
  });

  it('exposes stats only while its peer connection session is active', async () => {
    const { controller } = makeHarness();
    expect(await controller.getStatsReport()).toBeUndefined();

    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const report = await controller.getStatsReport();
    expect(report?.get('transport')).toMatchObject({ selectedCandidatePairId: 'pair' });

    controller.close();
    expect(await controller.getStatsReport()).toBeUndefined();
  });

  it('falls back after inbound video RTP stops growing for five seconds', async () => {
    let now = 0;
    const { controller, runHealthCheck } = makeHarness({ now: () => now });
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    const videoTrack = pc.fireTrack('video', makeStream());
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getState()).toBe('p2p');

    pc.autoProgress = false;
    for (let elapsed = 0; elapsed < P2P_RTP_STALL_TIMEOUT_MS + 1_000; elapsed += 1_000) {
      now += 1_000;
      await runHealthCheck();
    }

    expect(pc.getStats.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(controller.getState()).toBe('livekit');
  });

  it('still detects a complete RTP stall after decoded media on an unknown path', async () => {
    let now = 0;
    const { controller, runHealthCheck } = makeHarness({ now: () => now });
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsOmitPair = true;
    const videoTrack = pc.fireTrack('video', makeStream());
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState()).toBe('negotiating');

    pc.autoProgress = false;
    for (let elapsed = 0; elapsed < P2P_RTP_STALL_TIMEOUT_MS + 1_000; elapsed += 1_000) {
      now += 1_000;
      await runHealthCheck();
    }

    expect(controller.getState()).toBe('livekit');
  });

  it('falls back after eight consecutive populated intervals at fifteen percent loss', async () => {
    const { controller, runHealthCheck } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsPacketsReceived = 100;
    const videoTrack = pc.fireTrack('video', makeStream());
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getState()).toBe('p2p');

    for (let sample = 1; sample <= 7; sample++) {
      pc.statsPacketsReceived += 17;
      pc.statsPacketsLost += 3;
      await runHealthCheck();
      expect(controller.getState()).toBe('p2p');
    }

    pc.statsPacketsReceived += 17;
    pc.statsPacketsLost += 3;
    await runHealthCheck();
    expect(controller.getState()).toBe('livekit');
  });

  it('resets the poor-quality streak after one healthy interval', async () => {
    const { controller, runHealthCheck } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsPacketsReceived = 100;
    const videoTrack = pc.fireTrack('video', makeStream());
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(0);

    for (let sample = 0; sample < 7; sample++) {
      pc.statsPacketsReceived += 17;
      pc.statsPacketsLost += 3;
      await runHealthCheck();
    }
    pc.statsPacketsReceived += 20;
    await runHealthCheck();

    for (let sample = 0; sample < 7; sample++) {
      pc.statsPacketsReceived += 17;
      pc.statsPacketsLost += 3;
      await runHealthCheck();
    }
    expect(controller.getState()).toBe('p2p');

    pc.statsPacketsReceived += 17;
    pc.statsPacketsLost += 3;
    await runHealthCheck();
    expect(controller.getState()).toBe('livekit');
  });

  it('ignores high loss percentages when an interval has fewer than twenty packets', async () => {
    const { controller, runHealthCheck } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    const videoTrack = pc.fireTrack('video', makeStream());
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(0);

    for (let sample = 0; sample < 12; sample++) {
      pc.statsPacketsReceived += 1;
      pc.statsPacketsLost += 1;
      await runHealthCheck();
    }

    expect(controller.getState()).toBe('p2p');
  });

  it('falls back after freezes grow for eight consecutive populated intervals', async () => {
    const { controller, runHealthCheck } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    const videoTrack = pc.fireTrack('video', makeStream());
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(0);

    for (let sample = 1; sample <= 7; sample++) {
      pc.statsPacketsReceived += 20;
      pc.statsFreezeCount += 1;
      await runHealthCheck();
      expect(controller.getState()).toBe('p2p');
    }

    pc.statsPacketsReceived += 20;
    pc.statsFreezeCount += 1;
    await runHealthCheck();
    expect(controller.getState()).toBe('livekit');
  });

  it('keeps the p2p stream and connection until fallback handover completes', async () => {
    let completeFallback: (() => void) | undefined;
    const { controller } = makeHarness({
      onFallbackRequested: (complete) => { completeFallback = complete; }
    });
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    const stream = makeStream();
    const videoTrack = pc.fireTrack('video', stream);
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(1_000);

    pc.setIceConnectionState('failed');

    expect(controller.getState()).toBe('livekit');
    expect(controller.getStream()).toBe(stream);
    expect(pc.closed).toBe(false);
    completeFallback?.();
    expect(controller.getStream()).toBeNull();
    expect(pc.closed).toBe(true);
  });

  it('falls back 8 seconds after the answer when no track ever arrives', async () => {
    const { controller, signaling, onFallback } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];

    vi.advanceTimersByTime(P2P_ICE_NEGOTIATION_TIMEOUT_MS - 1);
    expect(controller.getState()).toBe('negotiating');

    vi.advanceTimersByTime(1);

    expect(controller.getState()).toBe('livekit');
    expect(signaling.sendBye).toHaveBeenCalledWith('sharer-1', 'fallback');
    expect(onFallback).toHaveBeenCalledOnce();
    expect(pc.closed).toBe(true);
    expect(controller.getStream()).toBeNull();
  });

  it('falls back 8 seconds after the answer when the video track never receives RTP', async () => {
    const { controller, signaling } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    pc.fireTrack('video', makeStream()); // stays muted

    vi.advanceTimersByTime(P2P_ICE_NEGOTIATION_TIMEOUT_MS);

    expect(controller.getState()).toBe('livekit');
    expect(signaling.sendBye).toHaveBeenCalledWith('sharer-1', 'fallback');
  });

  it('falls back when applying the remote offer fails', async () => {
    const { controller, signaling, onFallback } = makeHarness({
      onPcCreated: (pc) => { pc.failRemoteDescription = true; }
    });

    await controller.acceptOffer('sharer-1', 'offer-sdp');

    expect(controller.getState()).toBe('livekit');
    expect(signaling.sendBye).toHaveBeenCalledWith('sharer-1', 'fallback');
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it('is idempotent on close, clears timers and state, and ignores later offers', async () => {
    const { controller, signaling, onFallback } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    const stream = makeStream();
    const videoTrack = pc.fireTrack('video', stream);
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(1_000);

    controller.close();

    expect(pc.closed).toBe(true);
    expect(controller.getState()).toBe('idle');
    expect(controller.getStream()).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(onFallback).not.toHaveBeenCalled();
    expect(signaling.sendBye).not.toHaveBeenCalled();

    controller.close(); // idempotent
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
  });

  it('does not fire a phantom fallback when close races an in-flight acceptOffer', async () => {
    let rejectRemoteDescription!: (reason: Error) => void;
    const gate = new Promise<void>((_, reject) => { rejectRemoteDescription = reject; });
    const { controller, onFallback } = makeHarness({
      onPcCreated: (pc) => { pc.setRemoteDescriptionGate = gate; }
    });

    const acceptPromise = controller.acceptOffer('sharer-1', 'offer-sdp');
    controller.close();
    rejectRemoteDescription(new Error('pc closed'));
    await acceptPromise;

    expect(onFallback).not.toHaveBeenCalled();
    expect(controller.getState()).toBe('idle');
  });

  it('falls back 5 seconds after ICE stays disconnected while media is flowing', async () => {
    const { controller, signaling, onFallback } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    const stream = makeStream();
    const videoTrack = pc.fireTrack('video', stream);
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getState()).toBe('p2p');

    pc.setIceConnectionState('disconnected');
    vi.advanceTimersByTime(P2P_ICE_DISCONNECT_TIMEOUT_MS - 1);
    expect(controller.getState()).toBe('p2p');

    vi.advanceTimersByTime(1);

    expect(controller.getState()).toBe('livekit');
    expect(signaling.sendBye).toHaveBeenCalledWith('sharer-1', 'fallback');
    expect(onFallback).toHaveBeenCalledOnce();
    expect(pc.closed).toBe(true);
  });

  it('falls back from negotiating when ICE stays disconnected', async () => {
    const { controller, signaling } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];

    pc.setIceConnectionState('disconnected');
    vi.advanceTimersByTime(P2P_ICE_DISCONNECT_TIMEOUT_MS);

    expect(controller.getState()).toBe('livekit');
    expect(signaling.sendBye).toHaveBeenCalledWith('sharer-1', 'fallback');
    expect(pc.closed).toBe(true);
  });

  it('falls back immediately when ICE reaches failed', async () => {
    const { controller, signaling, onFallback } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    const stream = makeStream();
    const videoTrack = pc.fireTrack('video', stream);
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(1_000);

    pc.setIceConnectionState('failed');

    expect(controller.getState()).toBe('livekit');
    expect(signaling.sendBye).toHaveBeenCalledWith('sharer-1', 'fallback');
    expect(onFallback).toHaveBeenCalledOnce();
    expect(pc.closed).toBe(true);
  });

  it('does not fall back when ICE reconnects within the 5s window', async () => {
    const { controller, signaling, onFallback } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];
    const stream = makeStream();
    const videoTrack = pc.fireTrack('video', stream);
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getState()).toBe('p2p');

    pc.setIceConnectionState('disconnected');
    vi.advanceTimersByTime(4_000);
    pc.setIceConnectionState('connected');

    vi.advanceTimersByTime(P2P_ICE_DISCONNECT_TIMEOUT_MS + 5_000);
    expect(controller.getState()).toBe('p2p');
    expect(signaling.sendBye).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('ignores ICE connection events once the session is closed', async () => {
    const { controller, signaling } = makeHarness();
    await controller.acceptOffer('sharer-1', 'offer-sdp');
    const pc = FakeRTCPeerConnection.instances[0];

    controller.close();
    pc.setIceConnectionState('disconnected');
    vi.advanceTimersByTime(P2P_ICE_DISCONNECT_TIMEOUT_MS + 5_000);

    expect(controller.getState()).toBe('idle');
    expect(signaling.sendBye).not.toHaveBeenCalled();
  });

  it('exposes the current sharer identity and clears it on close', async () => {
    const { controller } = makeHarness();
    expect(controller.getSharerIdentity()).toBeUndefined();

    await controller.acceptOffer('sharer-1', 'offer-sdp');
    expect(controller.getSharerIdentity()).toBe('sharer-1');

    controller.close();
    expect(controller.getSharerIdentity()).toBeUndefined();
  });

  it('emits state snapshots on subscribe and on every transition', async () => {
    const { controller } = makeHarness();
    const seen: ViewerP2pState[] = [];
    const unsubscribe = controller.subscribe((state) => seen.push(state));

    expect(seen).toEqual(['idle']);

    await controller.acceptOffer('sharer-1', 'offer-sdp');
    expect(seen.at(-1)).toBe('negotiating');

    const pc = FakeRTCPeerConnection.instances[0];
    const videoTrack = pc.fireTrack('video', makeStream());
    videoTrack.unmute();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen.at(-1)).toBe('p2p');

    unsubscribe();
    vi.advanceTimersByTime(P2P_ICE_NEGOTIATION_TIMEOUT_MS);
    expect(seen.at(-1)).toBe('p2p'); // no further emissions after unsubscribe
  });
});
