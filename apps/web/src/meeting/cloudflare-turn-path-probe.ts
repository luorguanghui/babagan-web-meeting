import {
  TURN_PROBE_LADDER_BPS,
  createTurnProbeCapacityState,
  markTurnProbeFailure,
  reduceTurnProbeWindow,
  type TurnPathProbeSnapshot,
  type TurnProbeCapacityState,
  type TurnProbeWindow
} from './cloudflare-turn-capacity.js';

export const TURN_PROBE_CHUNK_BYTES = 16 * 1024;
export const TURN_PROBE_HEADER_BYTES = 12;
export const TURN_PROBE_BUFFER_HIGH_WATER_BYTES = 1_048_576;
export const TURN_PROBE_BUFFERED_LOW_THRESHOLD_BYTES = 256 * 1024;

const PROBE_DATA_CHANNEL_LABEL = 'probe-data';
const PROBE_CONTROL_CHANNEL_LABEL = 'probe-control';
const NEGOTIATION_TIMEOUT_MS = 8_000;
const CHANNEL_POLL_MS = 25;
const LADDER_WINDOW_DURATION_MS = 500;
const RECOVERY_INTERVAL_MS = 10_000;
const RESULT_GRACE_MS = 200;
const RESULT_TIMEOUT_MS = 3_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const PACE_TICK_MS = 20;
const MAX_PENDING_VERIFICATIONS = 2;
const MAX_REMOTE_PENDING_DATA_BYTES = 2 * 1024 * 1024;

type ProbeControlMessage =
  | { type: 'start'; windowId: number; offeredBps: number; durationMs: number }
  | {
    type: 'result';
    windowId: number;
    confirmedBytes: number;
    receivedMessages: number;
    highestSequence: number;
  };

type ResultMessage = ProbeControlMessage & { type: 'result' };

export interface CloudflareTurnPathProbe {
  start(iceServers: RTCIceServer[]): Promise<void>;
  requestVerification(): void;
  getSnapshot(): TurnPathProbeSnapshot;
  subscribe(listener: (snapshot: TurnPathProbeSnapshot) => void): () => void;
  stop(): Promise<void>;
}

export interface CloudflareTurnPathProbeDependencies {
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  isDocumentVisible?: () => boolean;
  randomBytes?: (size: number) => Uint8Array;
}

interface RemoteWindowCounters {
  windowId: number;
  confirmedBytes: number;
  receivedMessages: number;
  highestSequence: number;
}

/**
 * Measures the shared uplink path to Cloudflare's TURN network with a
 * relay-to-relay loopback inside the sharer's browser. The probe owns two
 * temporary peer connections and never derives its offered rate from media
 * state, so a media cap pinned low cannot pull the probe down with it.
 */
export function createCloudflareTurnPathProbe(
  dependencies: CloudflareTurnPathProbeDependencies = {}
): CloudflareTurnPathProbe {
  const createPeerConnection = dependencies.createPeerConnection
    ?? ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  const now = dependencies.now ?? (() => Date.now());
  const schedule = dependencies.schedule
    ?? ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  const isDocumentVisible = dependencies.isDocumentVisible
    ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const randomBytes = dependencies.randomBytes
    ?? ((size: number) => crypto.getRandomValues(new Uint8Array(size)));

  let capacityState: TurnProbeCapacityState = createTurnProbeCapacityState();
  const listeners = new Set<(snapshot: TurnPathProbeSnapshot) => void>();

  let stopped = false;
  let started = false;
  let lastIceServers: RTCIceServer[] = [];
  let left: RTCPeerConnection | undefined;
  let right: RTCPeerConnection | undefined;
  let dataChannel: RTCDataChannel | undefined;
  let controlChannel: RTCDataChannel | undefined;
  let selectedProtocol: string | undefined;
  let relayValidated = false;

  let ladderIndex = 0;
  let pendingVerifications = 0;
  let windowActive = false;
  let windowId = 0;
  let retryAttempt = 0;
  let cancelDriver: (() => void) | undefined;
  let cancelRetry: (() => void) | undefined;
  let cancelChannelPoll: (() => void) | undefined;
  let sentMessages = 0;
  let paceBudgetBytes = 0;
  let remoteCounters: RemoteWindowCounters | undefined;
  let resolveResult: ((message: ResultMessage) => void) | undefined;
  let rejectResult: ((reason: Error) => void) | undefined;
  let cancelResultWait: (() => void) | undefined;
  let cancelRemoteResultTimer: (() => void) | undefined;
  let resolvePaceTick: (() => void) | undefined;
  let remotePendingData: ArrayBuffer[] = [];

  const probe: CloudflareTurnPathProbe = {
    async start(iceServers: RTCIceServer[]): Promise<void> {
      if (started || stopped) return;
      started = true;
      lastIceServers = iceServers;
      publish({ ...capacityState.snapshot, status: 'negotiating' });
      try {
        await negotiate();
      } catch {
        // Negotiation failures retry on the backoff ladder; unsupported stops here.
        if (capacityState.snapshot.status !== 'unsupported') {
          publishFailure();
          scheduleRetry();
        }
      }
    },
    requestVerification(): void {
      if (stopped || !started) return;
      pendingVerifications = Math.min(pendingVerifications + 1, MAX_PENDING_VERIFICATIONS);
      scheduleDriver(0);
    },
    getSnapshot(): TurnPathProbeSnapshot {
      return capacityState.snapshot;
    },
    subscribe(listener: (snapshot: TurnPathProbeSnapshot) => void): () => void {
      listeners.add(listener);
      listener(capacityState.snapshot);
      return () => listeners.delete(listener);
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      teardownConnections();
      cancelDriver?.();
      cancelRetry?.();
      cancelChannelPoll?.();
      cancelDriver = undefined;
      cancelRetry = undefined;
      cancelChannelPoll = undefined;
    }
  };

  function publish(snapshot: TurnPathProbeSnapshot): void {
    capacityState = { ...capacityState, snapshot };
    for (const listener of [...listeners]) listener(snapshot);
  }

  function teardownConnections(): void {
    for (const channel of [dataChannel, controlChannel]) {
      if (!channel) continue;
      channel.onmessage = null;
      channel.onopen = null;
      channel.onbufferedamountlow = null;
      try {
        channel.close();
      } catch {
        // Closing an already-closed channel must not break the probe.
      }
    }
    dataChannel = undefined;
    controlChannel = undefined;
    for (const peer of [left, right]) {
      if (!peer) continue;
      peer.onicecandidate = null;
      peer.ondatachannel = null;
      try {
        peer.close();
      } catch {
        // Closing an already-closed peer must not break the probe.
      }
    }
    left = undefined;
    right = undefined;
    relayValidated = false;
    windowActive = false;
    remoteCounters = undefined;
    remotePendingData = [];
    cancelResultWait?.();
    cancelResultWait = undefined;
    cancelRemoteResultTimer?.();
    cancelRemoteResultTimer = undefined;
    resolveResult = undefined;
    rejectResult?.(new Error('probe stopped'));
    rejectResult = undefined;
    resolvePaceTick?.();
    resolvePaceTick = undefined;
  }

  async function negotiate(): Promise<void> {
    teardownConnections();
    cancelChannelPoll?.();
    cancelChannelPoll = undefined;
    publish({ ...capacityState.snapshot, status: 'negotiating' });
    const configuration: RTCConfiguration = { iceServers: lastIceServers, iceTransportPolicy: 'relay' };
    left = createPeerConnection(configuration);
    right = createPeerConnection(configuration);

    const leftPending: RTCIceCandidate[] = [];
    const rightPending: RTCIceCandidate[] = [];
    left.onicecandidate = ({ candidate }) => {
      if (!candidate || !right) return;
      if (right.remoteDescription) void right.addIceCandidate(candidate).catch(() => undefined);
      else leftPending.push(candidate);
    };
    right.onicecandidate = ({ candidate }) => {
      if (!candidate || !left) return;
      if (left.remoteDescription) void left.addIceCandidate(candidate).catch(() => undefined);
      else rightPending.push(candidate);
    };
    right.ondatachannel = ({ channel }) => {
      if (channel.label === PROBE_DATA_CHANNEL_LABEL) attachRemoteDataChannel(channel);
      else if (channel.label === PROBE_CONTROL_CHANNEL_LABEL) attachRemoteControlChannel(channel);
    };

    dataChannel = left.createDataChannel(PROBE_DATA_CHANNEL_LABEL, {
      ordered: false,
      maxRetransmits: 0,
      protocol: 'binary'
    });
    dataChannel.binaryType = 'arraybuffer';
    dataChannel.bufferedAmountLowThreshold = TURN_PROBE_BUFFERED_LOW_THRESHOLD_BYTES;
    dataChannel.onbufferedamountlow = () => resolvePaceTick?.();
    controlChannel = left.createDataChannel(PROBE_CONTROL_CHANNEL_LABEL, { ordered: true });
    controlChannel.onmessage = ({ data }) => handleControlMessage(data);

    await left.setLocalDescription(await left.createOffer());
    await right.setRemoteDescription(left.localDescription as RTCSessionDescriptionInit);
    for (const candidate of leftPending.splice(0)) await right.addIceCandidate(candidate);
    await right.setLocalDescription(await right.createAnswer());
    await left.setRemoteDescription(right.localDescription as RTCSessionDescriptionInit);
    for (const candidate of rightPending.splice(0)) await left.addIceCandidate(candidate);

    await waitForOpenChannels();
    if (stopped) return;
    const validated = await validateRelaySelection();
    if (stopped) return;
    if (!validated) {
      // A non-relay or non-Cloudflare selected pair is a topology verdict, not a
      // transient failure: keep the snapshot unsupported and do not retry it.
      publish({ ...capacityState.snapshot, status: 'unsupported' });
      return;
    }

    retryAttempt = 0;
    ladderIndex = 0;
    publish({ ...capacityState.snapshot, status: 'probing' });
    scheduleDriver(0);
  }

  function waitForOpenChannels(): Promise<void> {
    const deadline = now() + NEGOTIATION_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const poll = () => {
        cancelChannelPoll = undefined;
        if (stopped) {
          reject(new Error('probe stopped'));
          return;
        }
        const open = (channel?: RTCDataChannel) => channel?.readyState === 'open';
        if (open(dataChannel) && open(controlChannel)) {
          resolve();
          return;
        }
        if (now() >= deadline) {
          reject(new Error('probe data channels did not open'));
          return;
        }
        cancelChannelPoll = schedule(poll, CHANNEL_POLL_MS);
      };
      poll();
    });
  }

  async function validateRelaySelection(): Promise<boolean> {
    const configCloudflareOnly = lastIceServers.length > 0 && lastIceServers.every((server) => {
      const urls = server.urls === undefined ? [] : Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.length > 0 && urls.every((url) => url.includes('turn.cloudflare.com'));
    });
    const localCandidates = await Promise.all([
      selectedRelayCandidate(left!, configCloudflareOnly),
      selectedRelayCandidate(right!, configCloudflareOnly)
    ]);
    const local = localCandidates[0];
    if (!localCandidates.every(Boolean) || !local) return false;
    selectedProtocol = (local.relayProtocol ?? local.protocol) as string | undefined;
    relayValidated = true;
    return true;
  }

  async function selectedRelayCandidate(
    peer: RTCPeerConnection,
    configCloudflareOnly: boolean
  ): Promise<Record<string, unknown> | undefined> {
    const stats = (await peer.getStats()) as unknown as Map<string, Record<string, unknown>>;
    const pair = findSelectedPair(stats);
    if (!pair) return undefined;
    const local = stats.get(String(pair.localCandidateId));
    const remote = stats.get(String(pair.remoteCandidateId));
    if (!local || local.candidateType !== 'relay' || remote?.candidateType !== 'relay') return undefined;
    const url = typeof local.url === 'string' ? local.url : undefined;
    if (url !== undefined && !url.includes('turn.cloudflare.com')) return undefined;
    if (url === undefined && !configCloudflareOnly) return undefined;
    return local;
  }

  function findSelectedPair(stats: Map<string, Record<string, unknown>>): Record<string, unknown> | undefined {
    for (const stat of stats.values()) {
      if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string') {
        const pair = stats.get(stat.selectedCandidatePairId);
        if (pair) return pair;
      }
    }
    for (const stat of stats.values()) {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || stat.selected)) {
        return stat;
      }
    }
    return undefined;
  }

  function scheduleDriver(delayMs: number): void {
    cancelDriver?.();
    cancelDriver = schedule(runDriver, delayMs);
  }

  function runDriver(): void {
    if (stopped || windowActive || !relayValidated) return;
    if (!isDocumentVisible()) {
      // Hidden tabs get timer-throttled; an active window now would be invalid.
      scheduleDriver(1_000);
      return;
    }
    if (ladderIndex < TURN_PROBE_LADDER_BPS.length) {
      void runWindow(TURN_PROBE_LADDER_BPS[ladderIndex], true);
      return;
    }
    if (pendingVerifications > 0) {
      pendingVerifications -= 1;
      void runWindow(capacityState.snapshot.probeTargetBps, false);
      return;
    }
    scheduleDriver(RECOVERY_INTERVAL_MS);
  }

  async function runWindow(offeredBps: number, isLadder: boolean): Promise<void> {
    if (stopped || windowActive || !dataChannel || !controlChannel) return;
    windowActive = true;
    windowId += 1;
    sentMessages = 0;
    paceBudgetBytes = 0;

    sendControl({ type: 'start', windowId, offeredBps, durationMs: LADDER_WINDOW_DURATION_MS });
    const startedAt = now();
    const deadline = startedAt + LADDER_WINDOW_DURATION_MS;

    while (!stopped && isDocumentVisible() && now() < deadline) {
      paceTickOnce(offeredBps);
      const ticked = new Promise<void>((resolve) => {
        resolvePaceTick = resolve;
      });
      const cancelTick = schedule(() => resolvePaceTick?.(), PACE_TICK_MS);
      await ticked;
      cancelTick();
      resolvePaceTick = undefined;
    }

    const runnable = !stopped && isDocumentVisible();
    let result: ResultMessage | undefined;
    if (runnable) {
      try {
        result = await awaitResult();
      } catch {
        result = undefined;
      }
    }
    windowActive = false;
    if (stopped) return;

    if (!runnable) {
      // Hidden mid-window: discard the window silently; the driver reschedules.
      scheduleDriver(1_000);
      return;
    }
    if (!result) {
      capacityState = markTurnProbeFailure(capacityState, now());
      publish(capacityState.snapshot);
      scheduleRetry();
      return;
    }

    const lossRatio = sentMessages === 0
      ? 1
      : Math.max(0, (sentMessages - result.receivedMessages) / sentMessages);
    const window: TurnProbeWindow = {
      offeredBps,
      confirmedBytes: result.confirmedBytes,
      durationMs: LADDER_WINDOW_DURATION_MS,
      lossRatio,
      pendingBytesAtEnd: dataChannel?.bufferedAmount ?? 0,
      sampledAt: now(),
      selectedProtocol
    };
    capacityState = reduceTurnProbeWindow(capacityState, window);
    publish(capacityState.snapshot);
    if (!isLadder) {
      scheduleDriver(RECOVERY_INTERVAL_MS);
      return;
    }
    if (capacityState.snapshot.probeTargetBps <= offeredBps) {
      // The path did not confirm this rung; stop climbing, keep light recovery.
      ladderIndex = TURN_PROBE_LADDER_BPS.length;
    } else {
      ladderIndex += 1;
    }
    scheduleDriver(0);
  }

  function paceTickOnce(offeredBps: number): void {
    if (!dataChannel) return;
    paceBudgetBytes += Math.floor((offeredBps / 8) * (PACE_TICK_MS / 1_000));
    while (
      paceBudgetBytes >= TURN_PROBE_CHUNK_BYTES
      && dataChannel.bufferedAmount < TURN_PROBE_BUFFER_HIGH_WATER_BYTES
    ) {
      const frame = new Uint8Array(TURN_PROBE_CHUNK_BYTES);
      const header = new DataView(frame.buffer);
      header.setUint32(0, windowId);
      header.setUint32(4, sentMessages);
      header.setUint32(8, TURN_PROBE_CHUNK_BYTES);
      frame.set(randomBytes(TURN_PROBE_CHUNK_BYTES - TURN_PROBE_HEADER_BYTES), TURN_PROBE_HEADER_BYTES);
      dataChannel.send(frame);
      sentMessages += 1;
      paceBudgetBytes -= TURN_PROBE_CHUNK_BYTES;
    }
  }

  function awaitResult(): Promise<ResultMessage> {
    return new Promise<ResultMessage>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
      cancelResultWait = schedule(() => {
        const rejectResultWait = rejectResult;
        resolveResult = undefined;
        rejectResult = undefined;
        cancelResultWait = undefined;
        rejectResultWait?.(new Error('probe result timed out'));
      }, RESULT_TIMEOUT_MS + RESULT_GRACE_MS);
    });
  }

  function attachRemoteDataChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    channel.onmessage = ({ data }) => {
      const counters = remoteCounters;
      if (!(data instanceof ArrayBuffer)) return;
      if (!counters) {
        const pendingBytes = remotePendingData.reduce((total, frame) => total + frame.byteLength, 0);
        if (pendingBytes + data.byteLength <= MAX_REMOTE_PENDING_DATA_BYTES) {
          remotePendingData.push(data);
        }
        return;
      }
      recordRemoteData(counters, data);
    };
  }

  function recordRemoteData(counters: RemoteWindowCounters, data: ArrayBuffer): void {
    if (data.byteLength < TURN_PROBE_HEADER_BYTES) return;
    const view = new DataView(data);
    if (view.getUint32(0) !== counters.windowId) return;
    counters.confirmedBytes += data.byteLength;
    counters.receivedMessages += 1;
    counters.highestSequence = Math.max(counters.highestSequence, view.getUint32(4));
  }

  function attachRemoteControlChannel(channel: RTCDataChannel): void {
    channel.onmessage = ({ data }) => {
      if (typeof data !== 'string') return;
      let message: ProbeControlMessage;
      try {
        message = JSON.parse(data) as ProbeControlMessage;
      } catch {
        return;
      }
      if (message.type !== 'start') return;
      cancelRemoteResultTimer?.();
      remoteCounters = {
        windowId: message.windowId,
        confirmedBytes: 0,
        receivedMessages: 0,
        highestSequence: 0
      };
      const pending = remotePendingData;
      remotePendingData = [];
      for (const frame of pending) recordRemoteData(remoteCounters, frame);
      cancelRemoteResultTimer = schedule(() => {
        const counters = remoteCounters;
        if (!counters || counters.windowId !== message.windowId) return;
        cancelRemoteResultTimer = undefined;
        try {
          // The remote side replies on its own channel, back toward the sender.
          channel.send(JSON.stringify({
            type: 'result',
            windowId: counters.windowId,
            confirmedBytes: counters.confirmedBytes,
            receivedMessages: counters.receivedMessages,
            highestSequence: counters.highestSequence
          }));
        } catch {
          // A closed remote channel ends the window through the result timeout.
        }
      }, message.durationMs + RESULT_GRACE_MS);
    };
  }

  function handleControlMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: ProbeControlMessage;
    try {
      message = JSON.parse(data) as ProbeControlMessage;
    } catch {
      return;
    }
    if (message.type !== 'result' || message.windowId !== windowId) return;
    cancelResultWait?.();
    cancelResultWait = undefined;
    const resolve = resolveResult;
    resolveResult = undefined;
    rejectResult = undefined;
    resolve?.(message);
  }

  function sendControl(message: ProbeControlMessage): void {
    try {
      controlChannel?.send(JSON.stringify(message));
    } catch {
      // A closed control channel surfaces through the result timeout.
    }
  }

  function scheduleRetry(): void {
    if (stopped) return;
    const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
    retryAttempt += 1;
    cancelRetry?.();
    cancelRetry = schedule(() => {
      cancelRetry = undefined;
      if (stopped || !started) return;
      void negotiate().catch(() => {
        if (capacityState.snapshot.status !== 'unsupported') {
          publishFailure();
          scheduleRetry();
        }
      });
    }, delay);
  }

  function publishFailure(): void {
    capacityState = markTurnProbeFailure(capacityState, now());
    publish(capacityState.snapshot);
  }

  return probe;
}
