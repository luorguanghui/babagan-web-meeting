import { P2P_MESSAGE_MAX_BYTES } from '@meeting/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { P2pRoomRegistry, type P2pSocket } from './room-registry.js';
import {
  P2P_CLOSE_HEARTBEAT_TIMEOUT,
  P2P_CLOSE_POLICY_VIOLATION,
  P2pSignalingSession
} from './signaling-session.js';

class FakeSocket implements P2pSocket {
  readonly sent: string[] = [];
  closeCode: number | undefined;
  closed = false;

  send(raw: string): void {
    this.sent.push(raw);
  }

  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }

  messages(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

interface Harness {
  registry: P2pRoomRegistry;
  now: number;
  shareIdentity: string | null;
  sockets: Map<string, FakeSocket>;
  sessions: Map<string, P2pSignalingSession>;
}

function createHarness(): Harness {
  return {
    registry: new P2pRoomRegistry(),
    now: 0,
    shareIdentity: null,
    sockets: new Map(),
    sessions: new Map()
  };
}

function createSession(
  harness: Harness,
  identity: string,
  nickname: string,
  overrides: {
    heartbeatTimeoutMs?: number;
    messageRateLimit?: { max: number; windowMs: number };
  } = {}
): { session: P2pSignalingSession; socket: FakeSocket } {
  const socket = new FakeSocket();
  const session = new P2pSignalingSession({
    registry: harness.registry,
    slug: 'meeting-a',
    identity,
    nickname,
    socket,
    getShareIdentity: () => harness.shareIdentity,
    clock: { now: () => harness.now },
    ...overrides
  });
  harness.sockets.set(identity, socket);
  harness.sessions.set(identity, session);
  session.start();
  return { session, socket };
}

const ping = JSON.stringify({ type: 'ping' });
const errorMessage = (code: string) => expect.objectContaining({ type: 'error', code });

describe('P2pSignalingSession', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('welcomes a new peer with the existing members and announces it to the others', () => {
    const harness = createHarness();
    createSession(harness, 'bob', 'Bob');
    const { socket: adaSocket } = createSession(harness, 'ada', 'Ada');

    expect(adaSocket.messages()).toContainEqual({
      type: 'welcome',
      peers: [{ identity: 'bob', nickname: 'Bob' }]
    });
    expect(harness.sockets.get('bob')!.messages()).toContainEqual({
      type: 'peer-joined',
      peer: { identity: 'ada', nickname: 'Ada' }
    });
  });

  it('does not list the joining peer itself in its own welcome', () => {
    const harness = createHarness();
    const { socket } = createSession(harness, 'ada', 'Ada');

    expect(socket.messages()).toContainEqual({ type: 'welcome', peers: [] });
    expect(socket.messages().filter((message) => message.type === 'peer-joined')).toEqual([]);
  });

  it('answers ping with pong', () => {
    const harness = createHarness();
    const { session, socket } = createSession(harness, 'ada', 'Ada');

    session.handleMessage(ping);

    expect(socket.messages()).toContainEqual({ type: 'pong' });
  });

  it('accepts a hello that matches the session identity', () => {
    const harness = createHarness();
    const { session, socket } = createSession(harness, 'ada', 'Ada');

    session.handleMessage(JSON.stringify({ type: 'hello', participantIdentity: 'ada' }));

    expect(socket.closed).toBe(false);
    expect(socket.messages().filter((message) => message.type === 'error')).toEqual([]);
  });

  it('disconnects when hello identity does not match the session identity', () => {
    const harness = createHarness();
    const { session, socket } = createSession(harness, 'ada', 'Ada');

    session.handleMessage(JSON.stringify({ type: 'hello', participantIdentity: 'other' }));

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(P2P_CLOSE_POLICY_VIOLATION);
    expect(socket.messages().at(-1)).toEqual(errorMessage('P2P_FORBIDDEN'));
  });

  it('closes: removes the peer from the room and announces peer-left', () => {
    const harness = createHarness();
    const { session: adaSession } = createSession(harness, 'ada', 'Ada');
    const { socket: bobSocket } = createSession(harness, 'bob', 'Bob');

    adaSession.close();

    expect(bobSocket.messages()).toContainEqual({ type: 'peer-left', peer: { identity: 'ada' } });
    expect(harness.registry.listPeers('meeting-a')).toEqual([{ identity: 'bob', nickname: 'Bob' }]);
  });

  it('close is idempotent', () => {
    const harness = createHarness();
    const { session } = createSession(harness, 'ada', 'Ada');

    session.close();
    session.close();

    expect(harness.registry.listPeers('meeting-a')).toEqual([]);
  });

  it('forwards an offer sent by the sharer, injecting the sender identity', () => {
    const harness = createHarness();
    harness.shareIdentity = 'ada';
    const { session: adaSession } = createSession(harness, 'ada', 'Ada');
    const { socket: bobSocket } = createSession(harness, 'bob', 'Bob');

    adaSession.handleMessage(JSON.stringify({ type: 'offer', to: 'bob', sdp: 'sdp-offer' }));

    expect(bobSocket.messages()).toContainEqual({
      type: 'offer', to: 'bob', sdp: 'sdp-offer', from: 'ada'
    });
  });

  it('rejects an offer from a non-sharer with P2P_FORBIDDEN and does not forward it', () => {
    const harness = createHarness();
    const { session: adaSession, socket: adaSocket } = createSession(harness, 'ada', 'Ada');
    const { socket: bobSocket } = createSession(harness, 'bob', 'Bob');

    adaSession.handleMessage(JSON.stringify({ type: 'offer', to: 'bob', sdp: 'sdp-offer' }));

    expect(adaSocket.messages().at(-1)).toEqual(errorMessage('P2P_FORBIDDEN'));
    expect(bobSocket.messages().filter((message) => message.type === 'offer')).toEqual([]);
  });

  it('forwards answer, ice and bye from a viewer to the sharer', () => {
    const harness = createHarness();
    harness.shareIdentity = 'ada';
    const { socket: adaSocket } = createSession(harness, 'ada', 'Ada');
    const { session: bobSession } = createSession(harness, 'bob', 'Bob');

    bobSession.handleMessage(JSON.stringify({ type: 'answer', to: 'ada', sdp: 'sdp-answer' }));
    bobSession.handleMessage(JSON.stringify({ type: 'ice', to: 'ada', candidate: 'candidate:1' }));
    bobSession.handleMessage(JSON.stringify({ type: 'bye', to: 'ada', reason: 'done' }));

    expect(adaSocket.messages()).toContainEqual({
      type: 'answer', to: 'ada', sdp: 'sdp-answer', from: 'bob'
    });
    expect(adaSocket.messages()).toContainEqual({
      type: 'ice', to: 'ada', candidate: 'candidate:1', from: 'bob'
    });
    expect(adaSocket.messages()).toContainEqual({ type: 'bye', to: 'ada', reason: 'done', from: 'bob' });
  });

  it('forwards media-ready only from a viewer to the current sharer', () => {
    const harness = createHarness();
    harness.shareIdentity = 'ada';
    const { session: adaSession, socket: adaSocket } = createSession(harness, 'ada', 'Ada');
    const { session: bobSession } = createSession(harness, 'bob', 'Bob');

    bobSession.handleMessage(JSON.stringify({ type: 'media-ready', to: 'ada' }));
    expect(adaSocket.messages()).toContainEqual({ type: 'media-ready', to: 'ada', from: 'bob' });

    adaSession.handleMessage(JSON.stringify({ type: 'media-ready', to: 'bob' }));
    expect(adaSocket.messages().at(-1)).toEqual(errorMessage('P2P_FORBIDDEN'));
  });

  it('forwards retry only from a viewer to the current sharer', () => {
    const harness = createHarness();
    harness.shareIdentity = 'ada';
    const { session: adaSession, socket: adaSocket } = createSession(harness, 'ada', 'Ada');
    const { session: bobSession } = createSession(harness, 'bob', 'Bob');

    bobSession.handleMessage(JSON.stringify({ type: 'retry', to: 'ada' }));
    expect(adaSocket.messages()).toContainEqual({ type: 'retry', to: 'ada', from: 'bob' });

    adaSession.handleMessage(JSON.stringify({ type: 'retry', to: 'bob' }));
    expect(adaSocket.messages().at(-1)).toEqual(errorMessage('P2P_FORBIDDEN'));
  });

  it('forwards ice and bye from the sharer to any online peer', () => {
    const harness = createHarness();
    harness.shareIdentity = 'ada';
    const { session: adaSession } = createSession(harness, 'ada', 'Ada');
    const { socket: bobSocket } = createSession(harness, 'bob', 'Bob');

    adaSession.handleMessage(JSON.stringify({ type: 'ice', to: 'bob', candidate: null }));
    adaSession.handleMessage(JSON.stringify({ type: 'bye', to: 'bob' }));

    expect(bobSocket.messages()).toContainEqual({ type: 'ice', to: 'bob', candidate: null, from: 'ada' });
    expect(bobSocket.messages()).toContainEqual({ type: 'bye', to: 'bob', from: 'ada' });
  });

  it('rejects answer/ice/bye between two non-sharers with P2P_FORBIDDEN', () => {
    const harness = createHarness();
    harness.shareIdentity = 'carol';
    const { session: adaSession, socket: adaSocket } = createSession(harness, 'ada', 'Ada');
    const { socket: bobSocket } = createSession(harness, 'bob', 'Bob');

    adaSession.handleMessage(JSON.stringify({ type: 'answer', to: 'bob', sdp: 'sdp-answer' }));

    expect(adaSocket.messages().at(-1)).toEqual(errorMessage('P2P_FORBIDDEN'));
    expect(bobSocket.messages().filter((message) => message.type === 'answer')).toEqual([]);
  });

  it('reports P2P_PEER_NOT_FOUND when the target is not online', () => {
    const harness = createHarness();
    harness.shareIdentity = 'ada';
    const { session: adaSession, socket: adaSocket } = createSession(harness, 'ada', 'Ada');

    adaSession.handleMessage(JSON.stringify({ type: 'offer', to: 'ghost', sdp: 'sdp-offer' }));

    expect(adaSocket.messages().at(-1)).toEqual(errorMessage('P2P_PEER_NOT_FOUND'));
  });

  it('rejects malformed JSON with an error and closes the connection', () => {
    const harness = createHarness();
    const { session, socket } = createSession(harness, 'ada', 'Ada');

    session.handleMessage('not json');

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(P2P_CLOSE_POLICY_VIOLATION);
    expect(socket.messages().at(-1)).toEqual(errorMessage('INVALID_MESSAGE'));
  });

  it('rejects a message larger than the 64 KiB contract limit', () => {
    const harness = createHarness();
    const { session, socket } = createSession(harness, 'ada', 'Ada');

    session.handleMessage(JSON.stringify({
      type: 'offer', to: 'bob', sdp: 'x'.repeat(P2P_MESSAGE_MAX_BYTES)
    }));

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(P2P_CLOSE_POLICY_VIOLATION);
    expect(socket.messages().at(-1)).toEqual(errorMessage('INVALID_MESSAGE'));
  });

  it('closes a connection that stays silent for 120 seconds', () => {
    const harness = createHarness();
    const { socket } = createSession(harness, 'ada', 'Ada');

    vi.advanceTimersByTime(119_999);
    expect(socket.closed).toBe(false);

    vi.advanceTimersByTime(1);
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(P2P_CLOSE_HEARTBEAT_TIMEOUT);
    expect(harness.registry.listPeers('meeting-a')).toEqual([]);
  });

  it('keeps the connection alive through a 60-second background-tab gap', () => {
    // Chrome throttles background-tab timers to roughly one firing per minute,
    // so a client can legitimately go silent for a full minute without being
    // dead. The 120 s timeout must tolerate that gap (regression test for the
    // 30 s timeout that dropped backgrounded meetings every half minute).
    const harness = createHarness();
    const { socket } = createSession(harness, 'ada', 'Ada');

    vi.advanceTimersByTime(60_000);
    expect(socket.closed).toBe(false);
  });

  it('treats any message as activity and resets the heartbeat timeout', () => {
    const harness = createHarness();
    const { session, socket } = createSession(harness, 'ada', 'Ada');

    // A backgrounded client would only get to ping after ~60 s; a message then
    // must reset the timer and keep the connection alive past the old 30 s cap.
    vi.advanceTimersByTime(60_000);
    session.handleMessage(ping);
    expect(socket.closed).toBe(false);

    vi.advanceTimersByTime(119_999);
    expect(socket.closed).toBe(false);

    vi.advanceTimersByTime(1);
    expect(socket.closed).toBe(true);
  });

  it('broadcasts peer-left when the heartbeat times out', () => {
    const harness = createHarness();
    createSession(harness, 'ada', 'Ada');
    const { socket: bobSocket } = createSession(harness, 'bob', 'Bob');

    vi.advanceTimersByTime(120_000);

    expect(bobSocket.messages()).toContainEqual({ type: 'peer-left', peer: { identity: 'ada' } });
  });

  it('rate limits messages per connection with a fixed window', () => {
    const harness = createHarness();
    const { session, socket } = createSession(harness, 'ada', 'Ada', {
      messageRateLimit: { max: 2, windowMs: 60_000 }
    });

    session.handleMessage(ping);
    session.handleMessage(ping);
    expect(socket.closed).toBe(false);

    session.handleMessage(ping);
    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(P2P_CLOSE_POLICY_VIOLATION);
    expect(socket.messages().at(-1)).toEqual(errorMessage('RATE_LIMITED'));
  });

  it('resets the rate limit window after it elapses', () => {
    const harness = createHarness();
    const { session, socket } = createSession(harness, 'ada', 'Ada', {
      messageRateLimit: { max: 2, windowMs: 60_000 }
    });

    session.handleMessage(ping);
    session.handleMessage(ping);
    harness.now += 60_000;
    session.handleMessage(ping);
    session.handleMessage(ping);

    expect(socket.closed).toBe(false);
    expect(socket.messages().filter((message) => message.type === 'pong')).toHaveLength(4);
  });

  it('does nothing after the connection is closed', () => {
    const harness = createHarness();
    const { session, socket } = createSession(harness, 'ada', 'Ada');

    session.close();
    session.handleMessage(ping);

    expect(socket.messages().filter((message) => message.type === 'pong')).toEqual([]);
  });

  it('delivers broadcastShareGone to connected peers', () => {
    const harness = createHarness();
    const { socket: adaSocket } = createSession(harness, 'ada', 'Ada');
    const { socket: bobSocket } = createSession(harness, 'bob', 'Bob');

    harness.registry.broadcastShareGone('meeting-a');

    expect(adaSocket.messages()).toContainEqual({ type: 'share-gone', reason: 'share released' });
    expect(bobSocket.messages()).toContainEqual({ type: 'share-gone', reason: 'share released' });
  });
});
