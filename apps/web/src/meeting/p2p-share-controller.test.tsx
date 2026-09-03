import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  P2P_ICE_DISCONNECT_TIMEOUT_MS,
  P2P_ICE_NEGOTIATION_TIMEOUT_MS,
  P2P_TOTAL_UPLINK_BUDGET_BPS,
  type P2pScreenBitrate
} from '@meeting/contracts';

import type { Peer } from './p2p-signaling.js';
import type { CloudflareTurnPathProbe } from './cloudflare-turn-path-probe.js';
import type { TurnPathProbeSnapshot } from './cloudflare-turn-capacity.js';
import {
  computeResolutionScale,
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
  activeParameterWrites = 0;
  concurrentParameterWrites = 0;
  rejectNextParameterWrite = false;
  setParametersGate?: Promise<void>;
  private parameters: RTCRtpSendParameters = {
    transactionId: 'tx-id',
    codecs: [],
    headerExtensions: [],
    rtcp: { reducedSize: false },
    encodings: [{ maxBitrate: 0 }]
  };
  readonly getParameters = vi.fn(() => this.parameters);
  readonly setParameters = vi.fn(async (parameters: RTCRtpSendParameters) => {
    if (this.activeParameterWrites > 0) {
      this.concurrentParameterWrites += 1;
      throw new Error('stale transactionId from a concurrent setParameters call');
    }
    this.activeParameterWrites += 1;
    try {
      if (this.rejectNextParameterWrite) {
        this.rejectNextParameterWrite = false;
        throw new Error('transient setParameters failure');
      }
      if (this.setParametersGate) await this.setParametersGate;
      this.parameters = parameters;
    } finally {
      this.activeParameterWrites -= 1;
    }
  });

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
  readonly addedTrackStreams: Array<MediaStream[] | undefined> = [];
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
  emitCandidateDuringSetLocalDescription = false;
  iceConnectionState: RTCIceConnectionState = 'new';
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  statsCandidateType: RTCIceCandidateType = 'srflx';
  readonly createOffer = vi.fn(async () => {
    if (this.createOfferGate) await this.createOfferGate;
    return { type: 'offer', sdp: `offer-${this.id}` };
  });
  readonly setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    if (this.emitCandidateDuringSetLocalDescription) {
      this.onicecandidate?.(makeCandidate('candidate:early 1 udp 1 1.2.3.4 5000 typ host'));
    }
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
  readonly setConfiguration = vi.fn();
  readonly getStats = vi.fn(async () => statsReport(this.statsCandidateType, this.senderStats));
  statsPathKnown = true;
  senderStats: {
    qualityLimitationReason?: string;
    framesPerSecond?: number;
    frameWidth?: number;
    frameHeight?: number;
    availableOutgoingBitrateBps?: number;
    bytesSent?: number;
    timestamp?: number;
  } = {};

  constructor(config: RTCConfiguration) {
    this.config = config;
    FakeRTCPeerConnection.instances.push(this);
  }

  get remoteDescription(): RTCSessionDescription | null {
    return (this.remoteDescriptions[this.remoteDescriptions.length - 1] ?? null) as RTCSessionDescription | null;
  }

  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
    this.addedTracks.push(track);
    this.addedTrackStreams.push(streams.length > 0 ? streams : undefined);
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

  setStatsPathKnown(known: boolean): void {
    this.statsPathKnown = known;
    this.getStats.mockImplementation(async () => known
      ? statsReport(this.statsCandidateType)
      : new Map() as unknown as RTCStatsReport);
  }
}

function statsReport(
  candidateType: RTCIceCandidateType,
  sender: {
    qualityLimitationReason?: string;
    framesPerSecond?: number;
    frameWidth?: number;
    frameHeight?: number;
    availableOutgoingBitrateBps?: number;
    bytesSent?: number;
    timestamp?: number;
  } = {}
): RTCStatsReport {
  const entries: Array<[string, RTCStats]> = [
    ['transport', { id: 'transport', type: 'transport', timestamp: 1, selectedCandidatePairId: 'pair' } as RTCStats],
    ['pair', {
      id: 'pair', type: 'candidate-pair', timestamp: 1, state: 'succeeded',
      localCandidateId: 'local', remoteCandidateId: 'remote',
      ...(sender.availableOutgoingBitrateBps === undefined
        ? {}
        : { availableOutgoingBitrate: sender.availableOutgoingBitrateBps })
    } as RTCStats],
    ['local', { id: 'local', type: 'local-candidate', timestamp: 1, candidateType } as RTCStats],
    ['remote', { id: 'remote', type: 'remote-candidate', timestamp: 1, candidateType: 'host' } as RTCStats]
  ];
  if (sender.qualityLimitationReason !== undefined
    || sender.framesPerSecond !== undefined
    || sender.bytesSent !== undefined
    || sender.timestamp !== undefined) {
    entries.push(['outbound', {
      id: 'outbound', type: 'outbound-rtp', timestamp: sender.timestamp ?? 1, kind: 'video',
      ...(sender.qualityLimitationReason !== undefined ? { qualityLimitationReason: sender.qualityLimitationReason } : {}),
      ...(sender.framesPerSecond !== undefined ? { framesPerSecond: sender.framesPerSecond } : {}),
      ...(sender.frameWidth !== undefined ? { frameWidth: sender.frameWidth } : {}),
      ...(sender.frameHeight !== undefined ? { frameHeight: sender.frameHeight } : {}),
      ...(sender.bytesSent !== undefined ? { bytesSent: sender.bytesSent } : {})
    } as RTCStats]);
  }
  return new Map(entries) as unknown as RTCStatsReport;
}

function makeTrack(kind: 'video' | 'audio', settings?: { width?: number; height?: number }): MediaStreamTrack {
  return {
    kind,
    ...(settings === undefined ? {} : { getSettings: () => settings })
  } as unknown as MediaStreamTrack;
}

function makeStream(video = true, audio = true, videoSettings?: { width?: number; height?: number }): MediaStream {
  return {
    getVideoTracks: () => (video ? [makeTrack('video', videoSettings)] : []),
    getAudioTracks: () => (audio ? [makeTrack('audio')] : [])
  } as unknown as MediaStream;
}

function videoSender(pc: FakeRTCPeerConnection): FakeRtpSender {
  return pc.senders.find((sender) => sender.track.kind === 'video')!;
}

function senderMaxBitrate(pc: FakeRTCPeerConnection): number | undefined {
  return videoSender(pc).getParameters().encodings[0]?.maxBitrate;
}

const iceServers: RTCIceServer[] = [{ urls: ['stun:stun.example.test:3478'] }];

function makeCandidate(raw: string, sdpMid = '0', sdpMLineIndex = 0): RTCPeerConnectionIceEvent {
  return {
    candidate: {
      toJSON: () => ({ candidate: raw, sdpMid, sdpMLineIndex, usernameFragment: 'ufrag' })
    }
  } as unknown as RTCPeerConnectionIceEvent;
}

interface FakeTurnPathProbe {
  probe: {
    start: ReturnType<typeof vi.fn>;
    requestVerification: ReturnType<typeof vi.fn>;
    getSnapshot: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  listeners: Set<(snapshot: TurnPathProbeSnapshot) => void>;
  publishedSnapshots: TurnPathProbeSnapshot[];
  setSnapshot(next: TurnPathProbeSnapshot): void;
}

function createFakeTurnPathProbe(): FakeTurnPathProbe {
  const listeners = new Set<(snapshot: TurnPathProbeSnapshot) => void>();
  const publishedSnapshots: TurnPathProbeSnapshot[] = [];
  let current: TurnPathProbeSnapshot = {
    status: 'ready',
    probeTargetBps: 2_000_000,
    stableCapacityBps: 4_000_000,
    sampledAt: 1_234
  };
  const probe = {
    start: vi.fn(async () => undefined),
    requestVerification: vi.fn(),
    getSnapshot: vi.fn(() => current),
    subscribe: vi.fn((listener: (snapshot: TurnPathProbeSnapshot) => void) => {
      listeners.add(listener);
      listener(current);
      publishedSnapshots.push(current);
      return () => listeners.delete(listener);
    }),
    stop: vi.fn(async () => undefined)
  };
  return {
    probe,
    listeners,
    publishedSnapshots,
    setSnapshot(next: TurnPathProbeSnapshot) {
      current = next;
    }
  };
}

function makeHarness(options: {
  onPcCreated?: (pc: FakeRTCPeerConnection) => void;
  turnProvider?: 'coturn' | 'cloudflare';
  turnCredentialsExpiresAt?: number;
  probes?: boolean;
  control?: boolean;
} = {}) {
  const signaling: P2pShareSignaling = { sendOffer: vi.fn(), sendIce: vi.fn(), sendBye: vi.fn() };
  const onViewerFallback = vi.fn();
  const onAllViewersClosed = vi.fn();
  const fetchIceServers = vi.fn(async () => options.turnProvider === undefined
    ? iceServers
    : {
      iceServers,
      turnProvider: options.turnProvider,
      ...(options.turnCredentialsExpiresAt === undefined
        ? {}
        : { turnCredentialsExpiresAt: options.turnCredentialsExpiresAt })
    });
  const transportChecks = new Set<() => Promise<void>>();
  const probes = { created: 0, items: [] as FakeTurnPathProbe[] };
  const controller = createP2pShareController({
    slug: 'meeting-slug',
    signaling,
    createPeerConnection: (servers) => {
      const pc = new FakeRTCPeerConnection({ iceServers: servers });
      options.onPcCreated?.(pc);
      return pc as unknown as RTCPeerConnection;
    },
    fetchIceServers,
    scheduleTransportChecks: (check) => {
      transportChecks.add(check);
      return () => transportChecks.delete(check);
    },
    onViewerFallback,
    onAllViewersClosed,
    ...(options.probes || options.control
      ? {
        createTurnPathProbe: () => {
          const fake = createFakeTurnPathProbe();
          probes.created += 1;
          probes.items.push(fake);
          return fake.probe as unknown as CloudflareTurnPathProbe;
        }
      }
      : {}),
    ...(options.control ? { cloudflareTurnControlMode: 'control' as const } : {})
  });
  const runTransportChecks = async () => {
    await Promise.all([...transportChecks].map((check) => check()));
  };
  return { controller, signaling, onViewerFallback, onAllViewersClosed, fetchIceServers, runTransportChecks, probes };
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
    const stream = makeStream();

    await controller.start(stream, shareOptions, viewers);

    expect(fetchIceServers).toHaveBeenCalledOnce();
    expect(FakeRTCPeerConnection.instances).toHaveLength(4);
    for (const pc of FakeRTCPeerConnection.instances) {
      expect(pc.config).toEqual({ iceServers });
      expect(pc.addedTracks.map((track) => track.kind)).toEqual(['video', 'audio']);
      expect(pc.transceivers[0]?.options).toEqual(expect.objectContaining({ streams: [stream] }));
      expect(pc.addedTrackStreams).toEqual([[stream]]);
      expect(pc.createOffer).toHaveBeenCalledOnce();
      expect(pc.localDescriptions[0]).toEqual({ type: 'offer', sdp: `offer-${pc.id}` });
    }
    expect(signaling.sendOffer).toHaveBeenCalledTimes(4);
    for (const [index, viewer] of viewers.entries()) {
      expect(signaling.sendOffer).toHaveBeenCalledWith(viewer.identity, `offer-${index}`, expect.any(String), 'coturn');
    }
    for (const viewer of viewers) {
      expect(controller.getViewerStates().get(viewer.identity)).toBe('negotiating');
    }
  });

  it('sends the actual TURN provider with a sharer offer', async () => {
    const sendOffer = vi.fn();
    const cloudflareIceServers: RTCIceServer[] = [{
      urls: ['turn:turn.cloudflare.com:3478'],
      username: 'u',
      credential: 'c'
    }];
    const controller = createP2pShareController({
      slug: 'meeting-slug',
      signaling: { sendOffer, sendIce: vi.fn(), sendBye: vi.fn() },
      fetchIceServers: async () => ({
        iceServers: cloudflareIceServers,
        turnProvider: 'cloudflare',
        turnCredentialsExpiresAt: 9_999_999_999
      }),
      createPeerConnection: (servers) =>
        new FakeRTCPeerConnection({ iceServers: servers }) as unknown as RTCPeerConnection
    });

    await controller.start(makeStream(), shareOptions, [{ identity: 'viewer-1', nickname: 'Bob' }]);

    expect(FakeRTCPeerConnection.instances[0]?.config).toEqual({ iceServers: cloudflareIceServers });
    expect(sendOffer).toHaveBeenCalledWith(
      'viewer-1',
      expect.any(String),
      expect.any(String),
      'cloudflare'
    );
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

  it('applies an aspect-preserving scale for non-16:9 captures', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(true, false, { width: 1600, height: 1200 }), shareOptions, [viewers[0]]);

    const scale = videoSender(FakeRTCPeerConnection.instances[0]).getParameters().encodings[0]?.scaleResolutionDownBy;
    expect(scale).toBeCloseTo(10 / 9, 5);
  });

  it('prefers the selected codec on the video transceiver', async () => {
    const { controller } = makeHarness();
    const capabilities = {
      codecs: [
        { mimeType: 'video/VP8' },
        { mimeType: 'video/rtx' },
        { mimeType: 'video/H264' },
        { mimeType: 'video/red' },
        { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f' },
        { mimeType: 'video/ulpfec' },
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
      { mimeType: 'video/rtx' },
      { mimeType: 'video/red' },
      { mimeType: 'video/ulpfec' },
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
      JSON.stringify({ candidate: 'candidate:1 1 udp 2122260223 1.2.3.4 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ufrag' }),
      expect.any(String)
    );

    pc.onicecandidate?.({ candidate: null } as unknown as RTCPeerConnectionIceEvent);
    expect(signaling.sendIce).toHaveBeenLastCalledWith('viewer-1', null, expect.any(String));
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

  it('re-drives the negotiation once with fresh ICE before falling back when ICE never connects', async () => {
    const { controller, onViewerFallback, fetchIceServers } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const firstPc = FakeRTCPeerConnection.instances[0];

    vi.advanceTimersByTime(P2P_ICE_NEGOTIATION_TIMEOUT_MS - 1);
    expect(controller.getViewerStates().get('viewer-1')).toBe('negotiating');
    expect(onViewerFallback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1); // first deadline → automatic re-drive
    await vi.advanceTimersByTimeAsync(0);

    expect(firstPc.closed).toBe(true);
    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    expect(fetchIceServers).toHaveBeenCalledTimes(2);
    expect(controller.getViewerStates().get('viewer-1')).toBe('negotiating');

    vi.advanceTimersByTime(P2P_ICE_NEGOTIATION_TIMEOUT_MS); // second deadline → fallback
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.getViewerStates().get('viewer-1')).toBe('livekit-fallback');
    expect(onViewerFallback).toHaveBeenCalledWith('viewer-1');
    expect(FakeRTCPeerConnection.instances[1].closed).toBe(true);
  });

  it('extends the negotiation deadline while ICE keeps making progress, capped at the maximum', async () => {
    const { controller, onViewerFallback, fetchIceServers } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];

    // Progress at 7s pushes the first deadline out to 15s.
    vi.advanceTimersByTime(7_000);
    pc.setIceConnectionState('checking');
    vi.advanceTimersByTime(7_000); // 14s: a fixed 8s deadline would have fired at 8s
    expect(controller.getViewerStates().get('viewer-1')).toBe('negotiating');
    expect(onViewerFallback).not.toHaveBeenCalled();
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);

    vi.advanceTimersByTime(1_000); // 15s deadline → automatic re-drive
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    expect(fetchIceServers).toHaveBeenCalledTimes(2);
  });

  it('does not re-drive or fall back when the share stops while the refresh is in flight', async () => {
    let resolveFetch!: (servers: RTCIceServer[]) => void;
    const { controller, onViewerFallback, fetchIceServers } = makeHarness();
    fetchIceServers.mockImplementationOnce(async () => iceServers);
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    fetchIceServers.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));

    vi.advanceTimersByTime(P2P_ICE_NEGOTIATION_TIMEOUT_MS); // auto-retry starts, parks on the fetch
    await controller.stop();
    resolveFetch(iceServers);
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.getViewerStates().size).toBe(0);
    expect(onViewerFallback).not.toHaveBeenCalled();
    expect(FakeRTCPeerConnection.instances).toHaveLength(1);
  });

  it('marks a viewer p2p only after connected transport and media-ready', async () => {
    const { controller, onViewerFallback } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];

    vi.advanceTimersByTime(7_000);
    pc.setIceConnectionState('connected');

    expect(controller.getViewerStates().get('viewer-1')).toBe('negotiating');
    controller.handleMediaReady('viewer-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getViewerStates().get('viewer-1')).toBe('p2p');
    vi.advanceTimersByTime(P2P_ICE_NEGOTIATION_TIMEOUT_MS + 5_000);
    expect(controller.getViewerStates().get('viewer-1')).toBe('p2p');
    expect(onViewerFallback).not.toHaveBeenCalled();
  });

  it('honors media-ready that arrives before the connected ICE state event', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];

    controller.handleMediaReady('viewer-1');
    expect(controller.getViewerStates().get('viewer-1')).toBe('negotiating');

    pc.setIceConnectionState('connected');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('p2p'));
  });

  it('applies the selected tier per viewer while the total stays under the uplink budget', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, viewers.slice(0, 3));

    // 3 viewers × 8 Mbps tier = 24 Mbps, which fits under the 40 Mbps budget.
    expect(FakeRTCPeerConnection.instances.map(senderMaxBitrate)).toEqual([
      8_000_000,
      8_000_000,
      8_000_000
    ]);
    expect(FakeRTCPeerConnection.instances.reduce(
      (sum, pc) => sum + (senderMaxBitrate(pc) ?? 0),
      0
    )).toBe(24_000_000);
  });

  it('keeps a 10 Mbps cap for four viewers within the 40 Mbps budget', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), { ...shareOptions, maxBitrate: 10_000_000 }, viewers);

    expect(FakeRTCPeerConnection.instances.map(senderMaxBitrate)).toEqual([
      10_000_000,
      10_000_000,
      10_000_000,
      10_000_000
    ]);
  });

  it('always signals the offer before candidates gathered during setLocalDescription', async () => {
    const { controller, signaling } = makeHarness({
      onPcCreated: (pc) => { pc.emitCandidateDuringSetLocalDescription = true; }
    });

    await controller.start(makeStream(), shareOptions, [viewers[0]]);

    expect(signaling.sendOffer).toHaveBeenCalledOnce();
    expect(signaling.sendIce).toHaveBeenCalledOnce();
    expect(vi.mocked(signaling.sendOffer).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(signaling.sendIce).mock.invocationCallOrder[0]);
  });

  it('rebalances per-viewer caps when viewers join and leave', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    expect(senderMaxBitrate(FakeRTCPeerConnection.instances[0])).toBe(8_000_000);

    await controller.start(makeStream(), shareOptions, viewers.slice(0, 2));
    expect(FakeRTCPeerConnection.instances.map(senderMaxBitrate)).toEqual([8_000_000, 8_000_000]);

    await controller.start(makeStream(), shareOptions, viewers.slice(0, 3));
    expect(FakeRTCPeerConnection.instances.map(senderMaxBitrate)).toEqual([8_000_000, 8_000_000, 8_000_000]);

    controller.handleViewerLeft('viewer-3');
    await vi.waitFor(() => expect(senderMaxBitrate(FakeRTCPeerConnection.instances[0])).toBe(8_000_000));
    expect(senderMaxBitrate(FakeRTCPeerConnection.instances[1])).toBe(8_000_000);
  });

  it('serializes rebalance writes per sender while a second viewer joins', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const firstPc = FakeRTCPeerConnection.instances[0];
    const firstSender = videoSender(firstPc);
    let releaseWrite!: () => void;
    firstSender.setParametersGate = new Promise<void>((resolve) => { releaseWrite = resolve; });

    const joinPromise = controller.start(makeStream(), shareOptions, viewers.slice(0, 2));
    await vi.waitFor(() => expect(firstSender.activeParameterWrites).toBe(1));
    expect(firstSender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({
      encodings: [expect.objectContaining({ maxBitrate: 8_000_000 })]
    }));

    firstPc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(firstSender.concurrentParameterWrites).toBe(0);

    releaseWrite();
    await joinPromise;
    await vi.advanceTimersByTimeAsync(0);
    expect(senderMaxBitrate(firstPc)).toBe(8_000_000);
    expect(firstSender.concurrentParameterWrites).toBe(0);
  });

  it('keeps sender tuning best-effort and retries on the next rebalance', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const firstPc = FakeRTCPeerConnection.instances[0];
    const firstSender = videoSender(firstPc);
    firstSender.rejectNextParameterWrite = true;

    firstPc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getViewerStates().get('viewer-1')).toBe('p2p');

    await controller.start(makeStream(), shareOptions, viewers.slice(0, 2));
    expect(FakeRTCPeerConnection.instances.map(senderMaxBitrate)).toEqual([8_000_000, 8_000_000]);
  });

  it('does not increase a session allocation after direct or unknown path classification', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, viewers.slice(0, 2));
    const [direct, unknown] = FakeRTCPeerConnection.instances;
    unknown.setStatsPathKnown(false);

    for (const [index, pc] of [direct, unknown].entries()) {
      pc.setIceConnectionState('connected');
      controller.handleMediaReady(viewers[index].identity);
    }
    await vi.advanceTimersByTimeAsync(0);

    expect([senderMaxBitrate(direct), senderMaxBitrate(unknown)]).toEqual([8_000_000, 8_000_000]);
  });

  it('reallocates a fallen-back viewer budget to the remaining active session', async () => {
    const { controller } = makeHarness();
    await controller.start(makeStream(), shareOptions, viewers.slice(0, 2));
    expect(FakeRTCPeerConnection.instances.map(senderMaxBitrate)).toEqual([8_000_000, 8_000_000]);

    FakeRTCPeerConnection.instances[1].setIceConnectionState('failed');

    await vi.waitFor(() => expect(senderMaxBitrate(FakeRTCPeerConnection.instances[0])).toBe(8_000_000));
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

  it('reports the provider used by each TURN viewer', async () => {
    const { controller } = makeHarness({ turnProvider: 'cloudflare' });
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');

    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));
    expect(controller.getViewerTurnProviders?.().get('viewer-1')).toBe('cloudflare');
  });

  it('does not start a probe for negotiating, direct, coturn, or SFU sessions', async () => {
    const direct = makeHarness({ probes: true });
    await direct.controller.start(makeStream(), shareOptions, [viewers[0]]);
    const directPc = FakeRTCPeerConnection.instances[0];
    directPc.statsCandidateType = 'srflx';
    directPc.setIceConnectionState('connected');
    direct.controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(direct.controller.getViewerStates().get('viewer-1')).toBe('p2p'));
    await direct.runTransportChecks();
    expect(direct.probes.created).toBe(0);

    const coturn = makeHarness({ turnProvider: 'coturn', probes: true });
    await coturn.controller.start(makeStream(), shareOptions, [viewers[0]]);
    const coturnPc = FakeRTCPeerConnection.instances.at(-1)!;
    coturnPc.statsCandidateType = 'relay';
    coturnPc.setIceConnectionState('connected');
    coturn.controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(coturn.controller.getViewerStates().get('viewer-1')).toBe('turn'));
    await coturn.runTransportChecks();
    expect(coturn.probes.created).toBe(0);

    const negotiating = makeHarness({ turnProvider: 'cloudflare', probes: true });
    await negotiating.controller.start(makeStream(), shareOptions, [viewers[0]]);
    expect(negotiating.probes.created).toBe(0);
    await negotiating.controller.stop();
  });

  it('starts one probe when the first viewer becomes Cloudflare turn', async () => {
    const { controller, probes, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare', probes: true });
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));
    await runTransportChecks();

    await vi.waitFor(() => expect(probes.created).toBe(1));
    await vi.waitFor(() => expect(probes.items[0].probe.start).toHaveBeenCalledWith(iceServers));
  });

  it('does not create another probe for additional Cloudflare viewers', async () => {
    const { controller, probes, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare', probes: true });
    await controller.start(makeStream(), shareOptions, viewers);
    for (const pc of FakeRTCPeerConnection.instances) {
      pc.statsCandidateType = 'relay';
      pc.setIceConnectionState('connected');
      controller.handleMediaReady(viewers[pc.id]?.identity ?? viewers[0].identity);
    }
    await vi.waitFor(() => expect([...controller.getViewerStates().values()]).toEqual(['turn', 'turn', 'turn', 'turn']));
    await runTransportChecks();

    await vi.waitFor(() => expect(probes.created).toBe(1));
    await controller.stop();
    expect(probes.items[0].probe.stop).toHaveBeenCalled();
  });

  it('keeps the probe while at least one Cloudflare viewer remains and stops after the final one leaves', async () => {
    const { controller, probes, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare', probes: true });
    await controller.start(makeStream(), shareOptions, [viewers[0], viewers[1]]);
    for (const pc of FakeRTCPeerConnection.instances) {
      pc.statsCandidateType = 'relay';
      pc.setIceConnectionState('connected');
      controller.handleMediaReady(viewers[pc.id]?.identity ?? viewers[0].identity);
    }
    await vi.waitFor(() => expect([...controller.getViewerStates().values()]).toEqual(['turn', 'turn']));
    await runTransportChecks();
    await vi.waitFor(() => expect(probes.created).toBe(1));

    controller.handleViewerLeft('viewer-1');
    await runTransportChecks();
    expect(probes.items[0].probe.stop).not.toHaveBeenCalled();

    controller.handleViewerLeft('viewer-2');
    await vi.waitFor(() => expect(probes.items[0].probe.stop).toHaveBeenCalled());
  });

  it('rebuilds the probe after Cloudflare credential refresh', async () => {
    const { controller, probes, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare', probes: true });
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));
    await runTransportChecks();
    await vi.waitFor(() => expect(probes.created).toBe(1));

    controller.refreshIceServers?.({
      iceServers: [{ urls: ['turn:turn.cloudflare.com:443?transport=tcp'] }],
      turnProvider: 'cloudflare'
    });

    await vi.waitFor(() => expect(probes.created).toBe(2));
    await vi.waitFor(() => expect(probes.items[0].probe.stop).toHaveBeenCalled());
    expect(probes.items[1].probe.start).toHaveBeenCalledWith([{ urls: ['turn:turn.cloudflare.com:443?transport=tcp'] }]);
  });

  it('publishes immutable probe snapshots without changing sender parameters in observation mode', async () => {
    const { controller, probes, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare', probes: true });
    const snapshots: TurnPathProbeSnapshot[] = [];
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    controller.subscribeTurnPathProbe?.((snapshot) => snapshots.push(snapshot));
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));

    pc.senderStats = {
      availableOutgoingBitrateBps: 700_000,
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 8,
      bytesSent: 1_000_000,
      timestamp: 1_000
    };
    await runTransportChecks();
    pc.senderStats = {
      availableOutgoingBitrateBps: 700_000,
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 8,
      bytesSent: 3_000_000,
      timestamp: 2_000
    };
    await runTransportChecks();

    const published = probes.items[0]?.publishedSnapshots.at(-1);
    expect(published).toBeDefined();
    expect(controller.getTurnPathProbeSnapshot?.()).toEqual(published);
    expect(snapshots).toContain(published);
    // Observation mode: the published snapshot alone never touches the sender.
    expect(senderMaxBitrate(pc)).toBe(8_000_000);
    expect(videoSender(pc).getParameters().encodings[0]?.scaleResolutionDownBy ?? 1).toBeLessThanOrEqual(1.1);
  });

  it('raises maxBitrate without changing the profile target when probe capacity is high', async () => {
    const { controller, probes, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare', control: true });
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));

    probes.items[0].setSnapshot({
      status: 'ready',
      probeTargetBps: 4_000_000,
      stableCapacityBps: 40_000_000,
      sampledAt: 1_000
    });
    for (let sample = 0; sample < 2; sample += 1) {
      pc.senderStats = {
        availableOutgoingBitrateBps: 700_000,
        qualityLimitationReason: 'none',
        framesPerSecond: 30,
        bytesSent: 2_000_000 + sample * 5_000_000,
        timestamp: 1_000 + sample * 1_000
      };
      await runTransportChecks();
    }

    // One 15% step on the transport cap; the probe headroom and profile target
    // never let it jump straight to the measured 40 Mbps.
    expect(senderMaxBitrate(pc)).toBe(9_200_000);
  });

  it('exposes fixed target and current transport cap for diagnostics', async () => {
    const { controller, probes, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare', control: true });
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));

    expect(controller.getEncodingDiagnostics?.().get('viewer-1')).toMatchObject({
      profileTargetBitrateBps: 8_000_000,
      transportBitrateCapBps: 8_000_000,
      scaleResolutionDownBy: 1
    });

    probes.items[0].setSnapshot({
      status: 'ready',
      probeTargetBps: 4_000_000,
      stableCapacityBps: 40_000_000,
      sampledAt: 1_000
    });
    for (let sample = 0; sample < 2; sample += 1) {
      pc.senderStats = {
        qualityLimitationReason: 'none',
        framesPerSecond: 30,
        bytesSent: 2_000_000 + sample * 5_000_000,
        timestamp: 1_000 + sample * 1_000
      };
      await runTransportChecks();
    }

    expect(controller.getEncodingDiagnostics?.().get('viewer-1')).toMatchObject({
      profileTargetBitrateBps: 8_000_000,
      transportBitrateCapBps: 9_200_000,
      scaleResolutionDownBy: 1
    });
  });

  it('does not lower maxBitrate for one low probe or one low RTC estimate', async () => {
    const { controller, probes, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare', control: true });
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));

    probes.items[0].setSnapshot({
      status: 'probing',
      probeTargetBps: 2_000_000,
      measuredCapacityBps: 500_000,
      sampledAt: 1_000
    });
    pc.senderStats = {
      availableOutgoingBitrateBps: 500_000,
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 10,
      bytesSent: 2_000_000,
      timestamp: 1_000
    };
    await runTransportChecks();

    expect(senderMaxBitrate(pc)).toBe(8_000_000);
    expect(videoSender(pc).getParameters().encodings[0]?.scaleResolutionDownBy ?? 1).toBe(1);
  });

  it('backs off only the pressured viewer after corroborated low probe windows', async () => {
    const { controller, probes, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare', control: true });
    await controller.start(makeStream(), shareOptions, [viewers[0], viewers[1]]);
    const pressured = FakeRTCPeerConnection.instances[0];
    const healthy = FakeRTCPeerConnection.instances[1];
    for (const pc of [pressured, healthy]) {
      pc.statsCandidateType = 'relay';
      pc.setIceConnectionState('connected');
      controller.handleMediaReady(viewers[pc.id]?.identity ?? viewers[0].identity);
    }
    await vi.waitFor(() => expect([...controller.getViewerStates().values()]).toEqual(['turn', 'turn']));

    for (let sample = 0; sample < 3; sample += 1) {
      probes.items[0].setSnapshot({
        status: 'ready',
        probeTargetBps: 2_000_000,
        measuredCapacityBps: 1_500_000,
        stableCapacityBps: 1_500_000,
        sampledAt: 1_000 + sample * 1_000
      });
      pressured.senderStats = {
        availableOutgoingBitrateBps: 700_000,
        qualityLimitationReason: 'bandwidth',
        framesPerSecond: 8,
        bytesSent: 2_000_000 + sample * 500_000,
        timestamp: 1_000 + sample * 1_000
      };
      healthy.senderStats = {
        availableOutgoingBitrateBps: 700_000,
        qualityLimitationReason: 'none',
        framesPerSecond: 30,
        bytesSent: 9_000_000 + sample * 5_000_000,
        timestamp: 1_000 + sample * 1_000
      };
      await runTransportChecks();
    }

    expect(senderMaxBitrate(pressured)).toBeLessThan(8_000_000);
    expect(senderMaxBitrate(healthy)).toBe(8_000_000);
  });

  it('does not include Cloudflare viewers in the aggregate uplink budget', async () => {
    const roster: Peer[] = [
      ...viewers,
      { identity: 'viewer-5', nickname: 'Eve' },
      { identity: 'viewer-6', nickname: 'Fay' },
      { identity: 'viewer-7', nickname: 'Gus' }
    ];
    const { controller, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare', control: true });
    await controller.start(makeStream(), shareOptions, roster);
    const cloudflarePc = FakeRTCPeerConnection.instances[0];
    cloudflarePc.statsCandidateType = 'relay';
    cloudflarePc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    for (let index = 1; index < roster.length; index += 1) {
      const pc = FakeRTCPeerConnection.instances[index];
      pc.statsCandidateType = 'srflx';
      pc.setIceConnectionState('connected');
      controller.handleMediaReady(roster[index].identity);
    }
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));
    await runTransportChecks();

    // Six budgeted direct viewers squeeze the 40 Mbps budget to ~6.67 Mbps each,
    // while the Cloudflare viewer keeps the full profile tier.
    expect(senderMaxBitrate(cloudflarePc)).toBe(8_000_000);
    expect(senderMaxBitrate(FakeRTCPeerConnection.instances[1])).toBe(Math.floor(P2P_TOTAL_UPLINK_BUDGET_BPS / 6));
  });

  it('requests probe verification when sender pressure begins', async () => {
    const { controller, probes, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare', control: true });
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));
    await vi.waitFor(() => expect(probes.created).toBe(1));

    pc.senderStats = {
      availableOutgoingBitrateBps: 700_000,
      qualityLimitationReason: 'none',
      framesPerSecond: 30,
      bytesSent: 1_000_000,
      timestamp: 1_000
    };
    await runTransportChecks();
    expect(probes.items[0].probe.requestVerification).not.toHaveBeenCalled();

    pc.senderStats = {
      availableOutgoingBitrateBps: 700_000,
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 8,
      bytesSent: 1_500_000,
      timestamp: 2_000
    };
    await runTransportChecks();
    expect(probes.items[0].probe.requestVerification).toHaveBeenCalledTimes(1);

    pc.senderStats = {
      availableOutgoingBitrateBps: 700_000,
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 8,
      bytesSent: 2_000_000,
      timestamp: 3_000
    };
    await runTransportChecks();
    expect(probes.items[0].probe.requestVerification).toHaveBeenCalledTimes(1);
  });

  it('applies continuous scale and 540p hard protection', async () => {
    const { controller, probes, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare', control: true });
    await controller.start(makeStream(true, false, { width: 1728, height: 1080 }), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));

    const scales: number[] = [];
    for (let sample = 0; sample < 6; sample += 1) {
      probes.items[0].setSnapshot({
        status: 'ready',
        probeTargetBps: 2_000_000,
        measuredCapacityBps: 1_500_000,
        stableCapacityBps: 1_500_000,
        sampledAt: 1_000 + sample * 1_000
      });
      pc.senderStats = {
        availableOutgoingBitrateBps: 700_000,
        qualityLimitationReason: 'bandwidth',
        framesPerSecond: 8,
        bytesSent: 2_000_000 + sample * 500_000,
        timestamp: 1_000 + sample * 1_000
      };
      await runTransportChecks();
      scales.push(videoSender(pc).getParameters().encodings[0]?.scaleResolutionDownBy ?? 1);
    }

    expect(scales[0]).toBe(1);
    expect(scales.at(-1)!).toBeGreaterThan(1.1);
    for (let index = 1; index < scales.length; index += 1) {
      expect(scales[index] / scales[index - 1]).toBeLessThanOrEqual(1.1 + 1e-9);
    }

    // The browser itself dropped to a 480p short side: hard protection kicks in.
    pc.senderStats = {
      availableOutgoingBitrateBps: 700_000,
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 8,
      bytesSent: 6_000_000,
      timestamp: 10_000,
      frameWidth: 854,
      frameHeight: 480
    };
    await runTransportChecks();
    expect(videoSender(pc).getParameters().degradationPreference).toBe('maintain-resolution');

    pc.senderStats = {
      availableOutgoingBitrateBps: 700_000,
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 8,
      bytesSent: 6_500_000,
      timestamp: 11_000,
      frameWidth: 1728,
      frameHeight: 1080
    };
    await runTransportChecks();
    expect(videoSender(pc).getParameters().degradationPreference).toBe('maintain-framerate');
  });

  it('updates the provider when a direct viewer later migrates to relay', async () => {
    const { controller, runTransportChecks } = makeHarness({ turnProvider: 'cloudflare' });
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('p2p'));

    const refreshIceServers = (controller as unknown as {
      refreshIceServers(configuration: {
        iceServers: RTCIceServer[];
        turnProvider: 'coturn' | 'cloudflare';
        turnCredentialsExpiresAt?: number;
      }): void;
    }).refreshIceServers;
    refreshIceServers.call(controller, {
      iceServers: [{ urls: ['turn:turn.example.test:3478'] }],
      turnProvider: 'coturn'
    });
    pc.statsCandidateType = 'relay';
    await runTransportChecks();

    expect(controller.getViewerStates().get('viewer-1')).toBe('turn');
    expect(controller.getViewerTurnProviders?.().get('viewer-1')).toBe('coturn');
  });

  it('refreshes active viewer peer connections before Cloudflare credentials expire', async () => {
    const { controller } = makeHarness({ turnProvider: 'cloudflare' });
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));
    const freshConfiguration = {
      iceServers: [{
        urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
        username: 'fresh-user',
        credential: 'fresh-credential'
      }],
      turnProvider: 'coturn' as const,
      turnCredentialsExpiresAt: Math.floor(Date.now() / 1_000) + 600
    };

    const refreshIceServers = (controller as unknown as {
      refreshIceServers?: (configuration: typeof freshConfiguration) => void;
    }).refreshIceServers;
    expect(typeof refreshIceServers).toBe('function');
    refreshIceServers?.call(controller, freshConfiguration);

    expect(pc.setConfiguration).toHaveBeenCalledWith({ iceServers: freshConfiguration.iceServers });
    expect(controller.getViewerTurnProviders?.().get('viewer-1')).toBe('cloudflare');
  });

  it('schedules an active-session credential refresh before expiry', async () => {
    const expiresAt = Math.floor(Date.now() / 1_000) + 61;
    const { controller } = makeHarness({ turnProvider: 'cloudflare', turnCredentialsExpiresAt: expiresAt });
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];

    await vi.advanceTimersByTimeAsync(2_000);

    expect(pc.setConfiguration).toHaveBeenCalledWith({ iceServers });
  });

  it('tracks selected-pair migration from direct to relay and back to direct', async () => {
    const { controller, runTransportChecks } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('p2p'));

    pc.statsCandidateType = 'relay';
    await runTransportChecks();
    expect(controller.getViewerStates().get('viewer-1')).toBe('turn');

    pc.setStatsPathKnown(false);
    await runTransportChecks();
    expect(controller.getViewerStates().get('viewer-1')).toBe('turn');

    pc.setStatsPathKnown(true);
    pc.statsCandidateType = 'srflx';
    await runTransportChecks();
    expect(controller.getViewerStates().get('viewer-1')).toBe('p2p');
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

  it('keeps a frame-rate-first session on frame-rate-first degradation under pressure', async () => {
    const { controller, runTransportChecks } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.advanceTimersByTimeAsync(0); // session is p2p, monitor armed

    pc.senderStats = { qualityLimitationReason: 'bandwidth', framesPerSecond: 12 };
    await runTransportChecks();
    await runTransportChecks();
    expect(videoSender(pc).getParameters().degradationPreference).toBe('maintain-framerate');

    await runTransportChecks(); // third consecutive starved sample keeps frame rate first
    expect(videoSender(pc).getParameters().degradationPreference).toBe('maintain-framerate');

    pc.senderStats = { qualityLimitationReason: 'none', framesPerSecond: 30 };
    for (let sample = 0; sample < 4; sample += 1) await runTransportChecks();
    expect(videoSender(pc).getParameters().degradationPreference).toBe('maintain-framerate');

    await runTransportChecks(); // fifth unconstrained sample → restored
    expect(videoSender(pc).getParameters().degradationPreference).toBe('maintain-framerate');
  });

  it('protects resolution when a direct P2P sender reports a 432x270 layer', async () => {
    const { controller, runTransportChecks } = makeHarness();
    await controller.start(makeStream(true, false, { width: 1728, height: 1080 }), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('p2p'));

    pc.senderStats = {
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 30,
      frameWidth: 432,
      frameHeight: 270
    };
    await runTransportChecks();

    expect(videoSender(pc).getParameters().degradationPreference).toBe('maintain-resolution');
  });

  it('protects resolution when a coturn relay sender reports a 432x270 layer', async () => {
    const { controller, runTransportChecks } = makeHarness({ turnProvider: 'coturn' });
    await controller.start(makeStream(true, false, { width: 1728, height: 1080 }), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.statsCandidateType = 'relay';
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.waitFor(() => expect(controller.getViewerStates().get('viewer-1')).toBe('turn'));

    pc.senderStats = {
      qualityLimitationReason: 'bandwidth',
      framesPerSecond: 30,
      frameWidth: 432,
      frameHeight: 270
    };
    await runTransportChecks();

    expect(videoSender(pc).getParameters().degradationPreference).toBe('maintain-resolution');
  });

  it('keeps the degradation preference when a bandwidth limit does not collapse frame rate', async () => {
    const { controller, runTransportChecks } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.advanceTimersByTimeAsync(0);

    pc.senderStats = { qualityLimitationReason: 'bandwidth', framesPerSecond: 28 };
    await runTransportChecks();
    await runTransportChecks();
    await runTransportChecks();

    expect(videoSender(pc).getParameters().degradationPreference).toBe('maintain-framerate');
  });

  it('refreshes cached ICE credentials before use when their TURN expiry is near', async () => {
    const { controller, fetchIceServers } = makeHarness();
    const nearExpiryUsername = `${Math.floor(Date.now() / 1_000) + 5}:viewer-1`;
    fetchIceServers.mockImplementationOnce(async () => [
      { urls: ['turn:turn.example.test:3478'], username: nearExpiryUsername, credential: 'secret' }
    ]);
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    expect(FakeRTCPeerConnection.instances[0].config).toEqual({
      iceServers: [{ urls: ['turn:turn.example.test:3478'], username: nearExpiryUsername, credential: 'secret' }]
    });

    // A second share session reuses the controller cache; the credentials
    // expire within the refresh margin, so they must be refetched instead of
    // silently losing the relay candidates.
    fetchIceServers.mockImplementationOnce(async () => iceServers);
    await controller.start(makeStream(), shareOptions, [viewers[1]]);
    expect(fetchIceServers).toHaveBeenCalledTimes(2);
    expect(FakeRTCPeerConnection.instances[1].config).toEqual({ iceServers });
  });

  it('falls back after ICE stays disconnected for 5 seconds', async () => {
    const { controller, onViewerFallback } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.setIceConnectionState('connected');
    controller.handleMediaReady('viewer-1');
    await vi.advanceTimersByTimeAsync(0);

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
    await vi.advanceTimersByTimeAsync(0);

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

  it('rebuilds negotiating sessions with fresh ICE on reconnect while adding new viewers', async () => {
    const { controller, signaling, fetchIceServers } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    expect(signaling.sendOffer).toHaveBeenCalledTimes(1);
    const oldPc = FakeRTCPeerConnection.instances[0];

    await controller.start(makeStream(), shareOptions, viewers.slice(0, 2), true);

    expect(oldPc.closed).toBe(true);
    expect(fetchIceServers).toHaveBeenCalledTimes(2);
    expect(FakeRTCPeerConnection.instances).toHaveLength(3);
    expect(signaling.sendOffer).toHaveBeenCalledTimes(3); // original + fresh viewer-1 + viewer-2
    expect(signaling.sendOffer).toHaveBeenCalledWith('viewer-1', 'offer-0', expect.any(String), 'coturn');
    expect(signaling.sendOffer).toHaveBeenLastCalledWith('viewer-2', 'offer-2', expect.any(String), 'coturn');
    expect(controller.getViewerStates().get('viewer-1')).toBe('negotiating');
  });

  it('ignores answers, ICE and media-ready from an older negotiation generation', async () => {
    const { controller, signaling } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    const oldGeneration = vi.mocked(signaling.sendOffer).mock.calls[0][2]!;

    await controller.start(makeStream(), shareOptions, [viewers[0]], true);
    const newPc = FakeRTCPeerConnection.instances.at(-1)!;
    const newGeneration = vi.mocked(signaling.sendOffer).mock.calls.at(-1)![2]!;
    newPc.setIceConnectionState('connected');

    await controller.handleAnswer('viewer-1', 'old-answer', oldGeneration);
    await controller.handleIce('viewer-1', JSON.stringify({ candidate: 'old-candidate' }), oldGeneration);
    controller.handleMediaReady('viewer-1', oldGeneration);
    expect(newPc.remoteDescriptions).toEqual([]);
    expect(newPc.addedIceCandidates).toEqual([]);
    expect(controller.getViewerStates().get('viewer-1')).toBe('negotiating');

    await controller.handleAnswer('viewer-1', 'new-answer', newGeneration);
    expect(newPc.remoteDescriptions).toEqual([{ type: 'answer', sdp: 'new-answer' }]);
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

  it('rebuilds a fallen-back viewer session with fresh credentials and offer on handleRetry', async () => {
    const { controller, signaling, fetchIceServers } = makeHarness();
    await controller.start(makeStream(), shareOptions, viewers.slice(0, 2));
    FakeRTCPeerConnection.instances[1].setIceConnectionState('failed'); // livekit-fallback
    expect(controller.getViewerStates().get('viewer-2')).toBe('livekit-fallback');
    await vi.waitFor(() => expect(senderMaxBitrate(FakeRTCPeerConnection.instances[0])).toBe(8_000_000));
    const oldPc = FakeRTCPeerConnection.instances[1];
    const offersBefore = (signaling.sendOffer as ReturnType<typeof vi.fn>).mock.calls.length;

    controller.handleRetry('viewer-2');
    await vi.waitFor(() => expect(FakeRTCPeerConnection.instances.length).toBeGreaterThan(2));
    const newPc = FakeRTCPeerConnection.instances.at(-1)!;

    expect(oldPc.closed).toBe(true);
    expect(newPc.closed).toBe(false);
    expect(controller.getViewerStates().get('viewer-2')).toBe('negotiating');
    expect([senderMaxBitrate(FakeRTCPeerConnection.instances[0]), senderMaxBitrate(newPc)])
      .toEqual([8_000_000, 8_000_000]);
    expect((signaling.sendOffer as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(offersBefore);
    expect(signaling.sendOffer).toHaveBeenLastCalledWith('viewer-2', expect.any(String), expect.any(String), 'coturn');
    expect(fetchIceServers).toHaveBeenCalledTimes(2);
  });

  it('keeps only the newest retry when credential refreshes overlap', async () => {
    const { controller, signaling, fetchIceServers } = makeHarness();
    await controller.start(makeStream(), shareOptions, [viewers[0]]);
    let resolveFirstRetry!: (servers: RTCIceServer[]) => void;
    let resolveSecondRetry!: (servers: RTCIceServer[]) => void;
    fetchIceServers
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstRetry = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondRetry = resolve; }));

    controller.handleRetry('viewer-1');
    controller.handleRetry('viewer-1');
    resolveFirstRetry(iceServers);
    resolveSecondRetry(iceServers);
    await vi.waitFor(() => expect(fetchIceServers).toHaveBeenCalledTimes(3));

    await vi.waitFor(() => expect(signaling.sendOffer).toHaveBeenCalledTimes(2));
    expect(FakeRTCPeerConnection.instances).toHaveLength(2);
    expect(FakeRTCPeerConnection.instances[0].closed).toBe(true);
    expect(FakeRTCPeerConnection.instances[1].closed).toBe(false);
  });

  it('re-drives every viewer with fresh credentials and sessions on retryAll', async () => {
    const { controller, signaling, fetchIceServers } = makeHarness();
    await controller.start(makeStream(), shareOptions, viewers.slice(0, 2));
    const oldPcs = [...FakeRTCPeerConnection.instances];
    const offersBefore = (signaling.sendOffer as ReturnType<typeof vi.fn>).mock.calls.length;

    await controller.retryAll(viewers.slice(0, 2));

    expect(oldPcs.every((pc) => pc.closed)).toBe(true);
    expect(FakeRTCPeerConnection.instances.length).toBe(oldPcs.length + 2);
    expect((signaling.sendOffer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(offersBefore + 2);
    expect(controller.getViewerStates().get('viewer-1')).toBe('negotiating');
    expect(controller.getViewerStates().get('viewer-2')).toBe('negotiating');
    expect(FakeRTCPeerConnection.instances.slice(-2).map(senderMaxBitrate)).toEqual([8_000_000, 8_000_000]);
    expect(fetchIceServers).toHaveBeenCalledTimes(2);
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
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)?.get('viewer-1')).toBe('p2p');

    unsubscribe();
    FakeRTCPeerConnection.instances[0].setIceConnectionState('failed');
    expect(seen.at(-1)?.get('viewer-1')).toBe('p2p'); // no further emissions after unsubscribe
  });
});

describe('computeResolutionScale', () => {
  it('scales oversized captures down to 1080p', () => {
    expect(computeResolutionScale({ width: 2560, height: 1440 })).toBeCloseTo(4 / 3, 5);
    expect(computeResolutionScale({ width: 3840, height: 2160 })).toBe(2);
  });

  it('keeps 1080p detail for a 4:3 capture whose short side exceeds 1080', () => {
    expect(computeResolutionScale({ width: 1600, height: 1200 })).toBeCloseTo(10 / 9, 5);
  });

  it('fits a wide capture to the 1080p bound without forcing a 16:9 output', () => {
    expect(computeResolutionScale({ width: 2560, height: 1080 })).toBeCloseTo(4 / 3, 5);
  });

  it('handles portrait captures using portrait bounds', () => {
    expect(computeResolutionScale({ width: 1440, height: 2560 })).toBeCloseTo(4 / 3, 5);
  });

  it('normalizes display-scaled 1080p captures to 720p', () => {
    expect(computeResolutionScale({ width: 1536, height: 864 })).toBeCloseTo(1536 / 1280, 5);
  });

  it('leaves native 1080p and 720p captures unscaled', () => {
    expect(computeResolutionScale({ width: 1920, height: 1080 })).toBeUndefined();
    expect(computeResolutionScale({ width: 1280, height: 720 })).toBeUndefined();
  });

  it('never scales up and tolerates missing dimensions', () => {
    expect(computeResolutionScale({ width: 800, height: 600 })).toBeUndefined();
    // 1366x768 is not exactly 16:9; the larger fit ratio binds, and the output
    // still preserves the capture's own aspect.
    expect(computeResolutionScale({ width: 1366, height: 768 })).toBeCloseTo(Math.max(1366 / 1280, 768 / 720), 5);
    expect(computeResolutionScale({})).toBeUndefined();
    expect(computeResolutionScale({ width: 1920 })).toBeUndefined();
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
