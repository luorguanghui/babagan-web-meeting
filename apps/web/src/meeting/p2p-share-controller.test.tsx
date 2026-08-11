import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  P2P_ICE_DISCONNECT_TIMEOUT_MS,
  P2P_ICE_NEGOTIATION_TIMEOUT_MS,
  type P2pScreenBitrate
} from '@meeting/contracts';

import type { Peer } from './p2p-signaling.js';
import {
  createP2pShareController,
  deserializeIceCandidate,
  serializeIceCandidate,
  type P2pShareOptions,
  type P2pShareSignaling,
  type ViewerSessionState
} from './p2p-share-controller.js';

const bitrate: P2pScreenBitrate = 8_000_000;

const shareOptions: P2pShareOptions = {
  maxBitrate: bitrate,
  frameRate: 30,
  degradationPreference: 'maintain-framerate',
  codec: 'h264'
};

class FakeRtpSender {
  readonly track: MediaStreamTrack;
  readonly getParameters = vi.fn(() => ({
    transactionId: 'tx-id',
    codecs: [],
    headerExtensions: [],
    rtcp: { reducedSize: false },
    encodings: [{ maxBitrate: 0 }]
  }));
  readonly setParameters = vi.fn(async (parameters: RTCRtpSendParameters) => parameters);

  constructor(track: MediaStreamTrack) {
    this.track = track;
  }
}

class FakeRtpTransceiver {
  readonly sender: FakeRtpSender;
  readonly setCodecPreferences = vi.fn(() => undefined);
  readonly options?: RTCRtpTransceiverInit;

  constructor(track: MediaStreamTrack, options?: RTCRtpTransceiverInit) {
    this.sender = new FakeRtpSender(track);
    this.options = options;
  }
}

let pcCounter = 0;

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  readonly id = pcCounter++;
  readonly config: RTCConfiguration;
  readonly addedTracks: MediaStreamTrack[] = [];
  readonly transceivers: FakeRtpTransceiver[] = [];
  readonly senders: FakeRtpSender[] = [];
  readonly remoteDescriptions: RTCSessionDescriptionInit[] = [];
  readonly localDescriptions: RTCSessionDescriptionInit[] = [];
  readonly addedIceCandidates: Array<RTCIceCandidateInit | undefined> = [];
  closed = false;
  failRemoteDescription = false;
  /** Test hooks: a pending (possibly rejecting) promise that parks the matching in-flight operation. */
  createOfferGate?: Promise<void>;
  setRemoteDescriptionGate?: Promise<void>;
  iceConnectionState: RTCIceConnectionState = 'new';
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  statsCandidateType: RTCIceCandidateType = 'srflx';
  readonly createOffer = vi.fn(async () => {
    if (this.createOfferGate) await this.createOfferGate;
    return { type: 'offer', sdp: `offer-${this.id}` };
  });
  readonly setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescriptions.push(description);
  });
  readonly setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    if (this.failRemoteDescription) throw new Error('bad sdp');
    if (this.setRemoteDescriptionGate) await this.setRemoteDescriptionGate;
    this.remoteDescriptions.push(description);
  });
  readonly addIceCandidate = vi.fn(async (candidate?: RTCIceCandidateInit | RTCIceCandidate) => {
    this.addedIceCandidates.push(candidate === undefined ? undefined : (candidate as RTCIceCandidateInit));
  });
  readonly getStats = vi.fn(async () => statsReport(this.statsCandidateType));

  constructor(config: RTCConfiguration) {
    this.config = config;
    FakeRTCPeerConnection.instances.push(this);
  }

  get remoteDescription(): RTCSessionDescription | null {
    return (this.remoteDescriptions[this.remoteDescriptions.length - 1] ?? null) as RTCSessionDescription | null;
  }

  addTrack(track: MediaStreamTrack): RTCRtpSender {
    this.addedTracks.push(track);
    const sender = new FakeRtpSender(track);
    this.senders.push(sender);
    return sender as unknown as RTCRtpSender;
  }

  addTransceiver(track: MediaStreamTrack, options?: RTCRtpTransceiverInit): RTCRtpTransceiver {
    this.addedTracks.push(track);
    const transceiver = new FakeRtpTransceiver(track, options);
    this.transceivers.push(transceiver);
    this.senders.push(transceiver.sender);
    return transceiver as unknown as RTCRtpTransceiver;
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
}

function statsReport(candidateType: RTCIceCandidateType): RTCStatsReport {
  return new Map<string, RTCStats>([
    ['transport', { id: 'transport', type: 'transport', timestamp: 1, selectedCandidatePairId: 'pair' } as RTCStats],
    ['pair', {
      id: 'pair', type: 'candidate-pair', timestamp: 1, state: 'succeeded',
      localCandidateId: 'local', remoteCandidateId: 'remote'
    } as RTCStats],
    ['local', { id: 'local', type: 'local-candidate', timestamp: 1, candidateType } as RTCStats],
    ['remote', { id: 'remote', type: 'remote-candidate', timestamp: 1, candidateType: 'host' } as RTCStats]
  ]) as unknown as RTCStatsReport;
}

function makeTrack(kind: 'video' | 'audio'): MediaStreamTrack {
  return { kind } as unknown as MediaStreamTrack;
}

function makeStream(video = true, audio = true): MediaStream {
  return {
    getVideoTracks: () => (video ? [makeTrack('video')] : []),
    getAudioTracks: () => (audio ? [makeTrack('audio')] : [])
  } as unknown as MediaStream;
}

const iceServers: RTCIceServer[] = [{ urls: ['stun:stun.example.test:3478'] }];

function makeCandidate(raw: string, sdpMid = '0', sdpMLineIndex = 0): RTCPeerConnectionIceEvent {
  return {
    candidate: {
      toJSON: () => ({ candidate: raw, sdpMid, sdpMLineIndex, usernameFragment: 'ufrag' })
    }
  } as unknown as RTCPeerConnectionIceEvent;
}

function makeHarness(options: { onPcCreated?: (pc: FakeRTCPeerConnection) => void } = {}) {
  const signaling: P2pShareSignaling = { sendOffer: vi.fn(), sendIce: vi.fn(), sendBye: vi.fn() };
  const onViewerFallback = vi.fn();
  const onAllViewersClosed = vi.fn();
  const fetchIceServers = vi.fn(async () => iceServers);
  const controller = createP2pShareController({
    slug: 'meeting-slug',
    signaling,
    createPeerConnection: (servers) => {
      const pc = new FakeRTCPeerConnection({ iceServers: servers });
      options.onPcCreated?.(pc);
      return pc as unknown as RTCPeerConnection;
    },
    fetchIceServers,
    onViewerFallback,
    onAllViewersClosed
  });
  return { controller, signaling, onViewerFallback, onAllViewersClosed, fetchIceServers };
}

const viewers: Peer[] = [
  { identity: 'viewer-1', nickname: 'Ada' },
  { identity: 'viewer-2', nickname: 'Ben' },
  { identity: 'viewer-3', nickname: 'Carol' },
  { identity: 'viewer-4', nickname: 'Dan' }
];

beforeEach(() => {
  FakeRTCPeerConnection.instances = [];
  pcCounter = 0;
  vi.unstubAllGlobals();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('p2p share controller', () => {
  it('creates one PC per viewer with video and audio on the same connection and sends offers', async () => {
    const { controller, signaling, fetchIceServers } = makeHarness();

    await controller.start(makeStream(), shareOptions, viewers);

    expect(fetchIceServers).toHaveBeenCalledOnce();
    expect(FakeRTCPeerConnection.instances).toHaveLength(4);
    for (const pc of FakeRTCPeerConnection.instances) {
      expect(pc.config).toEqual({ iceServers });
      expect(pc.addedTracks.map((track) => track.kind)).toEqual(['video', 'audio']);
      expect(pc.createOffer).toHaveBeenCalledOnce();
      expect(pc.localDescriptions[0]).toEqual({ type: 'offer', sdp: `offer-${pc.id}` });
    }
    expect(signaling.sendOffer).toHaveBeenCalledTimes(4);
    for (const [index, viewer] of viewers.entries()) {
      expect(signaling.sendOffer).toHaveBeenCalledWith(viewer.identity, `offer-${index}`);
    }
    for (const viewer of viewers) {
      expect(controller.getViewerStates().get(viewer.identity)).toBe('negotiating');
    }
  });

  it('caps bitrate and frame rate and applies the degradation preference on the video sender only', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);

    const pc = FakeRTCPeerConnection.instances[0];
    const videoSender = pc.senders.find((sender) => sender.track.kind === 'video')!;
    const audioSender = pc.senders.find((sender) => sender.track.kind === 'audio')!;
    expect(videoSender.setParameters).toHaveBeenCalledWith(expect.objectContaining({
      encodings: [{ maxBitrate: bitrate, maxFramerate: 30 }],
      degradationPreference: 'maintain-framerate'
    }));
    expect(audioSender.setParameters).not.toHaveBeenCalled();
  });

  it('prefers the selected codec on the video transceiver', async () => {
    const { controller } = makeHarness();
    const capabilities = {
      codecs: [
        { mimeType: 'video/VP8' },
        { mimeType: 'video/H264' },
        { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' },
        { mimeType: 'video/VP9' }
      ]
    };
    vi.stubGlobal('RTCRtpSender', { getCapabilities: vi.fn(() => capabilities) });

    await controller.start(makeStream(), { ...shareOptions, codec: 'h264' }, [viewers[0]]);

    const pc = FakeRTCPeerConnection.instances[0];
    const videoTransceiver = pc.transceivers.find((transceiver) => transceiver.sender.track.kind === 'video')!;
    expect(videoTransceiver.setCodecPreferences).toHaveBeenCalledWith([
      { mimeType: 'video/H264' },
      { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' },
      { mimeType: 'video/VP8' },
      { mimeType: 'video/VP9' }
    ]);
  });

  it('leaves codec preferences untouched for the auto codec', async () => {
    const { controller } = makeHarness();
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: vi.fn(() => ({ codecs: [{ mimeType: 'video/VP8' }] }))
    });

    await controller.start(makeStream(), { ...shareOptions, codec: 'auto' }, [viewers[0]]);

    const pc = FakeRTCPeerConnection.instances[0];
    const videoTransceiver = pc.transceivers.find((transceiver) => transceiver.sender.track.kind === 'video')!;
    expect(videoTransceiver.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('adds only the video track when the stream has no audio', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(true, false), shareOptions, [viewers[0]]);

    expect(FakeRTCPeerConnection.instances[0].addedTracks.map((track) => track.kind)).toEqual(['video']);
  });

  it('forwards local trickle candidates and end-of-candidates to signaling', async () => {
    const { controller, signaling } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];

    pc.onicecandidate?.(makeCandidate('candidate:1 1 udp 2122260223 1.2.3.4 5000 typ host'));
    expect(signaling.sendIce).toHaveBeenLastCalledWith(
      'viewer-1',
      JSON.stringify({ candidate: 'candidate:1 1 udp 2122260223 1.2.3.4 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ufrag' })
    );

    pc.onicecandidate?.({ candidate: null } as unknown as RTCPeerConnectionIceEvent);
    expect(signaling.sendIce).toHaveBeenLastCalledWith('viewer-1', null);
  });

  it('queues remote candidates until the answer is applied, then flushes them in order', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];

    await controller.handleIce('viewer-1', JSON.stringify({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }));
    await controller.handleIce('viewer-1', JSON.stringify({ candidate: 'candidate:2', sdpMid: '1', sdpMLineIndex: 1 }));
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    await controller.handleAnswer('viewer-1', 'answer-sdp');

    expect(pc.remoteDescriptions).toEqual([{ type: 'answer', sdp: 'answer-sdp' }]);
    expect(pc.addIceCandidate).toHaveBeenCalledTimes(2);
    expect(pc.addIceCandidate).toHaveBeenNthCalledWith(1, { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
    expect(pc.addIceCandidate).toHaveBeenNthCalledWith(2, { candidate: 'candidate:2', sdpMid: '1', sdpMLineIndex: 1 });

    await controller.handleIce('viewer-1', JSON.stringify({ candidate: 'candidate:3', sdpMid: '0', sdpMLineIndex: 0 }));
    expect(pc.addIceCandidate).toHaveBeenCalledTimes(3);
  });

  it('applies end-of-candidates and bare-string candidates after the answer', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];

    await controller.handleIce('viewer-1', null);
    await controller.handleIce('viewer-1', 'candidate:99 1 udp 1 1.2.3.4 99 typ host');
    await controller.handleAnswer('viewer-1', 'answer-sdp');

    expect(pc.addIceCandidate).toHaveBeenCalledTimes(2);
    expect(pc.addIceCandidate).toHaveBeenNthCalledWith(1, undefined); // end-of-candidates
    expect(pc.addIceCandidate).toHaveBeenNthCalledWith(2, { candidate: 'candidate:99 1 udp 1 1.2.3.4 99 typ host' });
  });

  it('ignores signaling for unknown viewers and for viewers that already fell back', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];

    await controller.handleAnswer('ghost', 'answer-sdp');
    await controller.handleIce('ghost', JSON.stringify({ candidate: 'candidate:1' }));
    expect(pc.remoteDescriptions).toHaveLength(0);
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    pc.setIceConnectionState('failed');
    expect(controller.getViewerStates().get('viewer-1')).toBe('livekit-fallback');
    await controller.handleAnswer('viewer-1', 'answer-sdp');
    expect(pc.remoteDescriptions).toHaveLength(0);
  });

  it('falls back after the 8s negotiation timeout when ICE never connects', async () => {
    const { controller, onViewerFallback } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];

    vi.advanceTimersByTime(P2P_ICE_NEGOTIATION_TIMEOUT_MS - 1);
    expect(controller.getViewerStates().get('viewer-1')).toBe('negotiating');
    expect(onViewerFallback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(controller.getViewerStates().get('viewer-1')).toBe('livekit-fallback');
    expect(onViewerFallback).toHaveBeenCalledWith('viewer-1');
    expect(pc.closed).toBe(true);
  });

  it('marks a viewer p2p only after connected transport and media-ready', async () => {
    const { controller, onViewerFallback } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];

    vi.advanceTimersByTime(7_000);
    pc.setIceConnectionState('connected');

    expect(controller.getViewerStates().get('viewer-1')).toBe('negotiating');
    controller.handleMediaReady('viewer-1');
    expect(controller.getViewerStates().get('viewer-1')).toBe('p2p');
    vi.advanceTimersByTime(P2P_ICE_NEGOTIATION_TIMEOUT_MS + 5_000);
    expect(controller.getViewerStates().get('viewer-1')).toBe('p2p');
    expect(onViewerFallback).not.toHaveBeenCalled();
  });

  it('reports TURN when the selected candidate pair uses a relay', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    pc.setIceConnectionState('connected');

    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));
  });

  it('returns stats for active viewer sessions and omits closed sessions', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0], viewers[1]]);

    expect(await controller.getStatsReports()).toHaveLength(2);
    controller.handleViewerLeft('viewer-1');
    expect(await controller.getStatsReports()).toHaveLength(1);
    await controller.stop();
    expect(await controller.getStatsReports()).toEqual([]);
  });

  it('falls back after ICE stays disconnected for 5 seconds', async () => {
    const { controller, onViewerFallback } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');

    pc.setIceConnectionState('disconnected');
    vi.advanceTimersByTime(P2P_ICE_DISCONNECT_TIMEOUT_MS - 1);
    expect(controller.getViewerStates().get('viewer-1')).toBe('p2p');
    expect(onViewerFallback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(controller.getViewerStates().get('viewer-1')).toBe('livekit-fallback');
    expect(onViewerFallback).toHaveBeenCalledWith('viewer-1');
    expect(pc.closed).toBe(true);
  });

  it('does not fall back when ICE reconnects within the 5s window', async () => {
    const { controller, onViewerFallback } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');

    pc.setIceConnectionState('disconnected');
    vi.advanceTimersByTime(4_000);
    pc.setIceConnectionState('connected');

    vi.advanceTimersByTime(P2P_ICE_DISCONNECT_TIMEOUT_MS + 5_000);
    expect(controller.getViewerStates().get('viewer-1')).toBe('p2p');
    expect(onViewerFallback).not.toHaveBeenCalled();
  });

  it('falls back immediately when ICE reaches failed', async () => {
    const { controller, onViewerFallback } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');

    pc.setIceConnectionState('failed');

    expect(controller.getViewerStates().get('viewer-1')).toBe('livekit-fallback');
    expect(onViewerFallback).toHaveBeenCalledWith('viewer-1');
  });

  it('falls back when applying the remote answer fails', async () => {
    const { controller, onViewerFallback } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.failRemoteDescription = true;

    await controller.handleAnswer('viewer-1', 'answer-sdp');

    expect(controller.getViewerStates().get('viewer-1')).toBe('livekit-fallback');
    expect(onViewerFallback).toHaveBeenCalledWith('viewer-1');
  });

  it('marks a departed viewer closed without sending a bye and notifies when all viewers are gone', async () => {
    const { controller, signaling, onAllViewersClosed } = makeHarness();
    await controller.start(makeStream(), shareOptions, viewers.slice(0, 2));
    const first = FakeRTCPeerConnection.instances[0];

    controller.handleViewerLeft('viewer-1');

    expect(first.closed).toBe(true);
    expect(controller.getViewerStates().get('viewer-1')).toBe('closed');
    expect(signaling.sendBye).not.toHaveBeenCalled();
    expect(onAllViewersClosed).not.toHaveBeenCalled();

    controller.handleViewerLeft('viewer-2');
    expect(controller.getViewerStates().get('viewer-2')).toBe('closed');
    expect(onAllViewersClosed).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_000);
    expect(controller.getViewerStates().get('viewer-1')).toBe('closed'); // no timers left to fire
  });

  it('stops all sessions with a bye for non-closed viewers, clears state, and is idempotent', async () => {
    const { controller, signaling, onViewerFallback } = makeHarness();
    await controller.start(makeStream(), shareOptions, viewers.slice(0, 2));
    const [pcA, pcB] = FakeRTCPeerConnection.instances;
    pcA.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1'); // viewer-1: p2p
    pcB.setIceConnectionState('failed'); // viewer-2: livekit-fallback

    await controller.stop();

    expect(signaling.sendBye).toHaveBeenCalledTimes(2);
    expect(signaling.sendBye).toHaveBeenCalledWith('viewer-1');
    expect(signaling.sendBye).toHaveBeenCalledWith('viewer-2');
    expect(pcA.closed).toBe(true);
    expect(pcB.closed).toBe(true);
    expect(controller.getViewerStates().size).toBe(0);

    await controller.stop(); // idempotent
    expect(signaling.sendBye).toHaveBeenCalledTimes(2);
    expect(onViewerFallback).toHaveBeenCalledTimes(1); // only viewer-2's failed

    vi.advanceTimersByTime(60_000);
    expect(onViewerFallback).toHaveBeenCalledTimes(1);
  });

  it('does not fire a phantom fallback when stop() races an in-flight offer', async () => {
    let rejectCreateOffer!: (reason: Error) => void;
    const offerGate = new Promise<void>((_, reject) => { rejectCreateOffer = reject; });
    const { controller, onViewerFallback } = makeHarness({
      onPcCreated: (pc) => { pc.createOfferGate = offerGate; }
    });

    const startPromise = controller.start(makeStream(), shareOptions, [viewers[0]]);
    await vi.advanceTimersByTimeAsync(0); // PC is created and establishSession parks on createOffer
    const stopPromise = controller.stop();
    rejectCreateOffer(new Error('pc closed'));
    await Promise.all([startPromise, stopPromise]);

    expect(onViewerFallback).not.toHaveBeenCalled();
    expect(controller.getViewerStates().size).toBe(0);
  });

  it('does not fire a phantom fallback when stop() races an in-flight answer', async () => {
    const { controller, onViewerFallback } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];

    let rejectRemoteDescription!: (reason: Error) => void;
    const gate = new Promise<void>((_, reject) => { rejectRemoteDescription = reject; });
    pc.setRemoteDescriptionGate = gate;

    const answerPromise = controller.handleAnswer('viewer-1', 'answer-sdp');
    await controller.stop();
    rejectRemoteDescription(new Error('pc closed'));
    await answerPromise;

    expect(onViewerFallback).not.toHaveBeenCalled();
    expect(controller.getViewerStates().size).toBe(0);
  });

  it('re-drives offers for negotiating viewers and adds new viewers on a later start', async () => {
    const { controller, signaling } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    expect(signaling.sendOffer).toHaveBeenCalledTimes(1);

    await controller.start(makeStream(), shareOptions, viewers.slice(0, 2));

    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    expect(signaling.sendOffer).toHaveBeenCalledTimes(3); // re-offer viewer-1 + first offer viewer-2
    expect(signaling.sendOffer).toHaveBeenCalledWith('viewer-1', 'offer-0');
    expect(signaling.sendOffer).toHaveBeenCalledWith('viewer-2', 'offer-1');
    expect(controller.getViewerStates().get('viewer-1')).toBe('negotiating');
  });

  it('replaces a closed session when the viewer returns in a later roster', async () => {
    const { controller, signaling } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    controller.handleViewerLeft('viewer-1');

    await controller.start(makeStream(), shareOptions, [viewers[0]]);

    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    expect(signaling.sendOffer).toHaveBeenCalledTimes(2);
    expect(controller.getViewerStates().get('viewer-1')).toBe('negotiating');
  });

  it('emits state snapshots on subscribe and on every transition', async () => {
    const { controller } = makeHarness();
    const seen: Array<ReadonlyMap<string, ViewerSessionState>> = [];
    const unsubscribe = controller.subscribe((states) => seen.push(states));

    expect(seen).toHaveLength(1); // immediate snapshot
    expect(seen[0].size).toBe(0);

    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    expect(seen.at(-1)?.get('viewer-1')).toBe('negotiating');

    FakeRTCPeerConnection.instances[0].setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    expect(seen.at(-1)?.get('viewer-1')).toBe('p2p');

    unsubscribe();
    FakeRTCPeerConnection.instances[0].setIceConnectionState('failed');
    expect(seen.at(-1)?.get('viewer-1')).toBe('p2p'); // no further emissions after unsubscribe
  });
});

describe('ice candidate serialization', () => {
  it('serializes to a JSON string that deserializes back to the same init', () => {
    const event = makeCandidate('candidate:1 1 udp 2122260223 1.2.3.4 5000 typ host', '0', 0);
    const serialized = serializeIceCandidate(event.candidate!);
    expect(typeof serialized).toBe('string');
    expect(deserializeIceCandidate(serialized)).toEqual({
      candidate: 'candidate:1 1 udp 2122260223 1.2.3.4 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: 'ufrag'
    });
  });

  it('treats non-JSON strings as bare candidates', () => {
    expect(deserializeIceCandidate('candidate:99 1 udp 1 1.2.3.4 99 typ host'))
      .toEqual({ candidate: 'candidate:99 1 udp 1 1.2.3.4 99 typ host' });
  });

  it('falls back to a bare candidate for JSON that is not an init', () => {
    expect(deserializeIceCandidate('{"not":"an init"}')).toEqual({ candidate: '{"not":"an init"}' });
  });
});
