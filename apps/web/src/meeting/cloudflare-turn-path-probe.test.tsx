import { describe, expect, it } from 'vitest';

import {
  TURN_PROBE_BUFFERED_LOW_THRESHOLD_BYTES,
  TURN_PROBE_CHUNK_BYTES,
  createCloudflareTurnPathProbe,
  type CloudflareTurnPathProbeDependencies
} from './cloudflare-turn-path-probe.js';
import { TURN_PROBE_LADDER_BPS } from './cloudflare-turn-capacity.js';

type StatsValue = Record<string, unknown>;

interface ScheduledTask {
  at: number;
  callback: () => void;
  cancelled: boolean;
}

class FakeClock {
  private time = 0;
  private tasks: ScheduledTask[] = [];

  readonly now = (): number => this.time;

  readonly schedule = (callback: () => void, delayMs: number): (() => void) => {
    const task: ScheduledTask = { at: this.time + delayMs, callback, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };

  /** Runs every due task in order, letting microtasks settle between callbacks. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const next = this.tasks
        .filter((task) => !task.cancelled && task.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.time = next.at;
      next.cancelled = true;
      next.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.time = target;
  }

  /** Advances until the condition holds; fails the test when it never does. */
  async settleUntil(condition: () => boolean, budgetMs = 120_000): Promise<void> {
    let remaining = budgetMs;
    while (!condition() && remaining > 0) {
      await this.advance(Math.min(25, remaining));
      remaining -= 25;
      await Promise.resolve();
    }
    expect(condition(), `condition not met within ${budgetMs}ms of fake time`).toBe(true);
  }
}

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'arraybuffer';
  onmessage: ((event: MessageEvent) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  frames: Array<ArrayBuffer | string> = [];
  /** Simulated network path: forward every frame to the remote channel. */
  forwardTo: FakeDataChannel | null = null;
  /** Drop every Nth forwarded frame to simulate loss; 0 keeps all frames. */
  dropEveryNth = 0;
  private forwardedCount = 0;

  constructor(
    readonly label: string,
    readonly ordered?: boolean,
    readonly maxRetransmits?: number
  ) {}

  send(data: ArrayBuffer | Uint8Array | string): void {
    const frame = typeof data === 'string'
      ? data
      : data instanceof ArrayBuffer ? data : (data.buffer.slice(0) as ArrayBuffer);
    this.frames.push(frame);
    if (this.forwardTo) {
      this.forwardedCount += 1;
      const dropped = this.dropEveryNth > 0 && this.forwardedCount % this.dropEveryNth === 0;
      if (!dropped) this.forwardTo.receive(frame);
    }
  }

  receive(frame: ArrayBuffer | string): void {
    this.onmessage?.({ data: frame } as MessageEvent);
  }

  close(): void {
    this.readyState = 'closed';
  }
}

class FakePeerConnection {
  readonly localDataChannels: FakeDataChannel[] = [];
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  addedCandidates: unknown[] = [];
  closed = false;
  localDescription: RTCSessionDescriptionInit | undefined;
  /** Candidates this peer emits while gathering (relay candidates in production). */
  gatherCandidates: Array<{ candidate: string; sdpMid: string }> = [];
  stats = new Map<string, StatsValue>();
  /** The peer on the other side of the local SDP exchange. */
  remotePeer: FakePeerConnection | null = null;

  constructor(readonly configuration: RTCConfiguration) {}

  createDataChannel(label: string, options: RTCDataChannelInit = {}): FakeDataChannel {
    const channel = new FakeDataChannel(label, options.ordered, options.maxRetransmits);
    this.localDataChannels.push(channel);
    return channel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    for (const candidate of this.gatherCandidates) {
      this.onicecandidate?.({ candidate } as unknown as RTCPeerConnectionIceEvent);
    }
    this.onicecandidate?.({ candidate: null } as unknown as RTCPeerConnectionIceEvent);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === 'offer' && this.remotePeer) {
      // The browser announces the offerer's channels as NEW objects on the
      // answerer once the offer is applied.
      for (const origin of this.remotePeer.localDataChannels) {
        const mirror = new FakeDataChannel(origin.label, origin.ordered, origin.maxRetransmits);
        this.localDataChannels.push(mirror);
        this.ondatachannel?.({ channel: mirror } as unknown as RTCDataChannelEvent);
      }
    }
  }

  async addIceCandidate(candidate: unknown): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  async getStats(): Promise<Map<string, StatsValue>> {
    return this.stats;
  }

  close(): void {
    this.closed = true;
    this.localDataChannels.forEach((channel) => channel.close());
  }
}

function relayStats(
  url = 'turn:turn.cloudflare.com:3478?transport=udp',
  candidateType = 'relay',
  pairId = 'pair-1'
): Map<string, StatsValue> {
  return new Map<string, StatsValue>([
    ['transport', { type: 'transport', selectedCandidatePairId: pairId }],
    [pairId, {
      id: pairId,
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'local-1',
      remoteCandidateId: 'remote-1'
    }],
    ['local-1', { type: 'local-candidate', candidateType, url, relayProtocol: 'udp', protocol: 'udp' }],
    ['remote-1', { type: 'remote-candidate', candidateType: 'relay' }]
  ]);
}

const cloudflareIceServers: RTCIceServer[] = [
  {
    urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
    username: 'user',
    credential: 'secret'
  }
];

interface Fixture {
  clock: FakeClock;
  left: FakePeerConnection;
  right: FakePeerConnection;
  probe: ReturnType<typeof createCloudflareTurnPathProbe>;
  configurations: RTCConfiguration[];
}

function relayPair(): { left: FakePeerConnection; right: FakePeerConnection } {
  const left = new FakePeerConnection({});
  const right = new FakePeerConnection({});
  left.remotePeer = right;
  right.remotePeer = left;
  left.stats = relayStats();
  right.stats = relayStats();
  left.gatherCandidates = [{ candidate: 'candidate relay udp', sdpMid: '0' }];
  right.gatherCandidates = [{ candidate: 'candidate relay udp', sdpMid: '0' }];
  return { left, right };
}

function probeFixture(
  clock: FakeClock,
  left: FakePeerConnection,
  right: FakePeerConnection,
  overrides: Partial<CloudflareTurnPathProbeDependencies> = {}
) {
  const configurations: RTCConfiguration[] = [];
  const created: FakePeerConnection[] = [];
  const probe = createCloudflareTurnPathProbe({
    createPeerConnection: (configuration) => {
      configurations.push(configuration);
      const peer = created.length === 0 ? left : right;
      created.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    now: clock.now,
    schedule: clock.schedule,
    isDocumentVisible: () => true,
    randomBytes: (size) => new Uint8Array(size).fill(7),
    ...overrides
  });
  return { probe, configurations };
}

/** Starts a probe against a healthy relay pair and waits for validation. */
async function startedProbe(
  overrides: Partial<CloudflareTurnPathProbeDependencies> = {}
): Promise<Fixture> {
  const clock = new FakeClock();
  const { left, right } = relayPair();
  const { probe, configurations } = probeFixture(clock, left, right, overrides);
  const startPromise = probe.start(cloudflareIceServers);
  await clock.settleUntil(() => probe.getSnapshot().status === 'probing');
  await startPromise;
  return { clock, left, right, probe, configurations };
}

/** Wires the simulated network: media frames and control messages flow both ways. */
function wireNetwork(left: FakePeerConnection, right: FakePeerConnection): FakeDataChannel {
  const leftData = left.localDataChannels.find((channel) => channel.label === 'probe-data')!;
  const leftControl = left.localDataChannels.find((channel) => channel.label === 'probe-control')!;
  const rightData = right.localDataChannels.find((channel) => channel.label === 'probe-data')!;
  const rightControl = right.localDataChannels.find((channel) => channel.label === 'probe-control')!;
  leftData.forwardTo = rightData;
  leftControl.forwardTo = rightControl;
  rightControl.forwardTo = leftControl;
  return leftData;
}

function startMessages(control: FakeDataChannel): Array<Record<string, number | string>> {
  const decoder = new TextDecoder();
  return control.frames.map((frame) => JSON.parse(
    typeof frame === 'string' ? frame : decoder.decode(frame)
  ) as Record<string, number | string>).filter((message) => message.type === 'start');
}

describe('Cloudflare TURN path probe', () => {
  it('forces relay policy on both peer connections', async () => {
    const { configurations } = await startedProbe();

    expect(configurations).toHaveLength(2);
    for (const configuration of configurations) {
      expect(configuration.iceTransportPolicy).toBe('relay');
      expect(configuration.iceServers).toBe(cloudflareIceServers);
    }
  });

  it('rejects a selected host or non-Cloudflare candidate', async () => {
    for (const localStats of [
      relayStats('turn:turn.cloudflare.com:3478?transport=udp', 'host'),
      relayStats('turn:turn.example.com:3478?transport=udp')
    ]) {
      const clock = new FakeClock();
      const { left, right } = relayPair();
      left.stats = localStats;
      const { probe } = probeFixture(clock, left, right);
      const startPromise = probe.start(cloudflareIceServers);
      await clock.settleUntil(() => probe.getSnapshot().status === 'unsupported');
      await startPromise;

      expect(probe.getSnapshot().status).toBe('unsupported');
      expect(left.closed).toBe(true);
      expect(right.closed).toBe(true);
      await probe.stop();
    }
  });

  it('publishes an unavailable status when relay negotiation fails and schedules a retry', async () => {
    const clock = new FakeClock();
    const { left, right } = relayPair();
    left.getStats = async () => { throw new Error('stats unavailable'); };
    right.getStats = async () => { throw new Error('stats unavailable'); };
    const { probe } = probeFixture(clock, left, right);
    const startPromise = probe.start(cloudflareIceServers);

    await clock.settleUntil(() => probe.getSnapshot().status === 'error');
    await startPromise;

    expect(probe.getSnapshot().status).toBe('error');
    expect(left.closed).toBe(true);
    expect(right.closed).toBe(true);
    await probe.stop();
  });

  it('opens unreliable data and reliable control channels', async () => {
    const { left } = await startedProbe();
    const data = left.localDataChannels.find((channel) => channel.label === 'probe-data');
    const control = left.localDataChannels.find((channel) => channel.label === 'probe-control');

    expect(data?.ordered).toBe(false);
    expect(data?.maxRetransmits).toBe(0);
    expect(control?.ordered).toBe(true);
    expect(control?.maxRetransmits).toBeUndefined();
  });

  it('paces 16 KiB chunks using bufferedAmountLowThreshold', async () => {
    const { clock, left, right, probe } = await startedProbe();
    const data = wireNetwork(left, right);
    probe.requestVerification();

    expect(data.bufferedAmountLowThreshold).toBe(TURN_PROBE_BUFFERED_LOW_THRESHOLD_BYTES);
    await clock.settleUntil(() => data.frames.length > 3);
    const dataFrames = data.frames.filter((frame): frame is ArrayBuffer => typeof frame !== 'string');
    for (const frame of dataFrames) {
      expect(frame.byteLength).toBe(TURN_PROBE_CHUNK_BYTES);
    }
    const header = new DataView(dataFrames[0]);
    expect(header.getUint32(8)).toBe(TURN_PROBE_CHUNK_BYTES);
    expect(header.getUint32(0)).toBeGreaterThan(0);
  });

  it('publishes confirmed rather than queued throughput', async () => {
    const { clock, left, right, probe } = await startedProbe();
    const data = wireNetwork(left, right);
    data.dropEveryNth = 4;
    probe.requestVerification();

    await clock.settleUntil(() => probe.getSnapshot().measuredCapacityBps !== undefined);
    const snapshot = probe.getSnapshot();
    const confirmedFrames = data.frames.length - Math.floor(data.frames.length / 4);
    expect(snapshot.measuredCapacityBps).toBeGreaterThan(0);
    expect(snapshot.measuredCapacityBps).toBeLessThanOrEqual(
      (confirmedFrames * TURN_PROBE_CHUNK_BYTES * 8_000) / 500 + 1
    );
  });

  it('runs only one verification window at a time', async () => {
    const { clock, left, right, probe } = await startedProbe();
    wireNetwork(left, right);
    const control = left.localDataChannels.find((channel) => channel.label === 'probe-control')!;

    probe.requestVerification();
    await clock.settleUntil(
      () => startMessages(control).length === TURN_PROBE_LADDER_BPS.length + 3
    );
    await clock.advance(1_500);

    // Startup stabilization owns three serial verification windows. A request
    // made during calibration coalesces into that queue rather than overlapping it.
    expect(startMessages(control)).toHaveLength(TURN_PROBE_LADDER_BPS.length + 3);
  });

  it('schedules two serial windows for one verification request after startup settles', async () => {
    const { clock, left, right, probe } = await startedProbe();
    wireNetwork(left, right);
    const control = left.localDataChannels.find((channel) => channel.label === 'probe-control')!;
    await clock.settleUntil(() => probe.getSnapshot().status === 'ready');
    const before = startMessages(control).length;

    probe.requestVerification();
    await clock.settleUntil(() => startMessages(control).length === before + 2);

    expect(startMessages(control)).toHaveLength(before + 2);
  });

  it('starts a queued verification immediately after an active recovery window', async () => {
    const { clock, left, right, probe } = await startedProbe();
    wireNetwork(left, right);
    const control = left.localDataChannels.find((channel) => channel.label === 'probe-control')!;

    await clock.settleUntil(() => probe.getSnapshot().status === 'ready');
    probe.requestVerification();
    await clock.settleUntil(() => startMessages(control).length >= TURN_PROBE_LADDER_BPS.length + 4);
    probe.requestVerification();
    const activeWindowCount = startMessages(control).length;
    await clock.settleUntil(() => startMessages(control).length === activeWindowCount + 1, 1_000);

    expect(startMessages(control)).toHaveLength(activeWindowCount + 1);
  });

  it('does not count data delivered before the control start message as loss', async () => {
    const { clock, left, right, probe } = await startedProbe();
    const data = wireNetwork(left, right);
    const leftControl = left.localDataChannels.find((channel) => channel.label === 'probe-control')!;
    const rightControl = right.localDataChannels.find((channel) => channel.label === 'probe-control')!;
    // Data and control channels have independent delivery order in WebRTC.
    leftControl.forwardTo = null;
    probe.requestVerification();

    await clock.settleUntil(() => data.frames.length > 3);
    rightControl.receive(leftControl.frames[0]!);
    leftControl.forwardTo = rightControl;
    await clock.settleUntil(() => probe.getSnapshot().measuredCapacityBps !== undefined);

    expect(probe.getSnapshot().lossRatio).toBe(0);
  });

  it('invalidates the probe when the selected path migrates away from Cloudflare relay', async () => {
    const { clock, left, right, probe } = await startedProbe();
    wireNetwork(left, right);
    const before = probe.getSnapshot().sampledAt;
    left.stats = relayStats('turn:turn.cloudflare.com:3478?transport=udp', 'host');
    probe.requestVerification();
    await clock.settleUntil(() => probe.getSnapshot().status === 'error', 1_000);

    expect(probe.getSnapshot().status).toBe('error');
    expect(probe.getSnapshot().sampledAt).toBe(before);
  });

  it('invalidates old capacity when either selected relay pair identity changes', async () => {
    const { clock, left, right, probe } = await startedProbe();
    wireNetwork(left, right);
    await clock.settleUntil(() => probe.getSnapshot().measuredCapacityBps !== undefined);
    const before = probe.getSnapshot().sampledAt;

    right.stats = relayStats('turn:turn.cloudflare.com:3478?transport=udp', 'relay', 'pair-2');
    probe.requestVerification();
    await clock.settleUntil(() => probe.getSnapshot().status === 'error', 1_000);

    expect(probe.getSnapshot().sampledAt).toBe(before);
    expect(left.closed).toBe(true);
    expect(right.closed).toBe(true);
  });

  it('publishes an unavailable status when a DataChannel send fails', async () => {
    const { clock, left, right, probe } = await startedProbe();
    const data = wireNetwork(left, right);
    data.send = () => { throw new Error('data channel closed'); };
    probe.requestVerification();

    await clock.settleUntil(() => probe.getSnapshot().status === 'error', 1_000);
    expect(probe.getSnapshot().status).toBe('error');
  });

  it('rejects a result whose confirmed bytes do not match its message count', async () => {
    const { clock, left, right, probe } = await startedProbe();
    wireNetwork(left, right);
    const rightControl = right.localDataChannels.find((channel) => channel.label === 'probe-control')!;
    const originalSend = rightControl.send.bind(rightControl);
    rightControl.send = (data) => {
      if (typeof data === 'string') {
        const message = JSON.parse(data) as { type?: string; confirmedBytes?: number };
        if (message.type === 'result') message.confirmedBytes = (message.confirmedBytes ?? 0) + 1;
        originalSend(JSON.stringify(message));
        return;
      }
      originalSend(data);
    };
    probe.requestVerification();

    await clock.settleUntil(() => probe.getSnapshot().status === 'error', 2_000);
    expect(probe.getSnapshot().measuredCapacityBps).toBeUndefined();
  });

  it('does not publish a zero-capacity result when every data chunk is lost', async () => {
    const { clock, left, right, probe } = await startedProbe();
    const data = wireNetwork(left, right);
    data.forwardTo = null;
    probe.requestVerification();

    await clock.settleUntil(() => probe.getSnapshot().status === 'error', 2_000);
    expect(probe.getSnapshot().measuredCapacityBps).toBeUndefined();
    expect(probe.getSnapshot().stableCapacityBps).toBeUndefined();
  });

  it('settles start when stopped while the channels are still negotiating', async () => {
    const clock = new FakeClock();
    const { left, right } = relayPair();
    const originalCreateDataChannel = left.createDataChannel.bind(left);
    left.createDataChannel = (label, options) => {
      const channel = originalCreateDataChannel(label, options);
      channel.readyState = 'connecting';
      return channel;
    };
    const { probe } = probeFixture(clock, left, right);
    const startPromise = probe.start(cloudflareIceServers);
    await clock.settleUntil(() => left.localDataChannels.length === 2);
    await clock.settleUntil(() => right.localDataChannels.length === 2);
    await clock.advance(25);
    await probe.stop();

    let settled = false;
    void startPromise.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('invalidates a window when the document is hidden', async () => {
    let visible = false;
    const { clock, left, right, probe } = await startedProbe({ isDocumentVisible: () => visible });
    wireNetwork(left, right);
    const before = probe.getSnapshot();
    probe.requestVerification();
    await clock.advance(2_000);

    expect(probe.getSnapshot().measuredCapacityBps).toBe(before.measuredCapacityBps);
    expect(probe.getSnapshot().status).not.toBe('error');

    visible = true;
    probe.requestVerification();
    await clock.settleUntil(() => probe.getSnapshot().measuredCapacityBps !== undefined);
  });

  it('stops both peers, channels, listeners, and timers idempotently', async () => {
    const { clock, left, right, probe } = await startedProbe();
    wireNetwork(left, right);

    await probe.stop();
    await probe.stop();

    expect(left.closed).toBe(true);
    expect(right.closed).toBe(true);
    for (const channel of left.localDataChannels) {
      expect(channel.readyState).toBe('closed');
    }

    const control = left.localDataChannels.find((channel) => channel.label === 'probe-control')!;
    const framesAfterStop = control.frames.length;
    await clock.advance(40_000);
    expect(control.frames.length).toBe(framesAfterStop);
  });

  it('walks the offered ladder and reports the selected protocol', async () => {
    const { clock, left, right, probe } = await startedProbe();
    wireNetwork(left, right);
    const control = left.localDataChannels.find((channel) => channel.label === 'probe-control')!;

    await clock.settleUntil(() => startMessages(control).length >= TURN_PROBE_LADDER_BPS.length);
    const offered = startMessages(control).map((message) => message.offeredBps);
    expect(offered.slice(0, TURN_PROBE_LADDER_BPS.length)).toEqual([...TURN_PROBE_LADDER_BPS]);
    expect(probe.getSnapshot().selectedProtocol).toBe('udp');
  });

  it('publishes ready only after three same-target post-ladder windows', async () => {
    const { clock, left, right, probe } = await startedProbe();
    wireNetwork(left, right);
    const control = left.localDataChannels.find((channel) => channel.label === 'probe-control')!;

    await clock.settleUntil(() => startMessages(control).length === TURN_PROBE_LADDER_BPS.length);
    expect(probe.getSnapshot().status).toBe('probing');
    expect(probe.getSnapshot().stableCapacityBps).toBeUndefined();

    await clock.settleUntil(() => startMessages(control).length === TURN_PROBE_LADDER_BPS.length + 3);
    await clock.settleUntil(() => probe.getSnapshot().status === 'ready');
    const verificationTargets = startMessages(control)
      .slice(TURN_PROBE_LADDER_BPS.length)
      .map((message) => message.offeredBps);
    expect(new Set(verificationTargets).size).toBe(1);
  });

  it('runs another verification window ten seconds after startup stabilization', async () => {
    const { clock, left, right, probe } = await startedProbe();
    wireNetwork(left, right);
    const control = left.localDataChannels.find((channel) => channel.label === 'probe-control')!;
    await clock.settleUntil(() => probe.getSnapshot().status === 'ready');
    const before = startMessages(control).length;

    await clock.settleUntil(() => startMessages(control).length > before, 11_000);

    expect(startMessages(control)).toHaveLength(before + 1);
  });

  it('invalidates stable capacity when a periodic check sees a new relay pair', async () => {
    const { clock, left, right, probe } = await startedProbe();
    wireNetwork(left, right);
    await clock.settleUntil(() => probe.getSnapshot().status === 'ready');
    const before = probe.getSnapshot().sampledAt;
    const beforeEpoch = probe.getSnapshot().pathEpoch;
    right.stats = relayStats('turn:turn.cloudflare.com:3478?transport=udp', 'relay', 'pair-2');

    await clock.settleUntil(() => probe.getSnapshot().status === 'stale', 11_000);

    expect(probe.getSnapshot().sampledAt).toBe(before);
    expect(probe.getSnapshot().pathEpoch).not.toBe(beforeEpoch);
    expect(left.closed).toBe(true);
    expect(right.closed).toBe(true);
  });
});
