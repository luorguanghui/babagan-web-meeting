import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildP2pSignalingUrl,
  createP2pSignalingClient,
  type P2pSignalingEvents,
  type P2pWebSocket
} from './p2p-signaling.js';

class FakeWebSocket implements P2pWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number): void {
    this.onclose?.({ code });
  }

  open(): void {
    this.onopen?.();
  }

  /** Delivers one JSON-encoded server frame. */
  message(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  /** Simulates the server dropping the connection (optionally after an error). */
  fail(code = 1006): void {
    this.onerror?.(new Error('socket error'));
    this.onclose?.({ code });
  }
}

function lastSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

function eventHandlers(): P2pSignalingEvents {
  return {
    onWelcome: vi.fn(),
    onPeerJoined: vi.fn(),
    onPeerLeft: vi.fn(),
    onOffer: vi.fn(),
    onAnswer: vi.fn(),
    onIce: vi.fn(),
    onMediaReady: vi.fn(),
    onBye: vi.fn(),
    onShareGone: vi.fn(),
    onError: vi.fn()
  };
}

const pageLocation = { protocol: 'https:', host: 'meet.example.test' };

const clients: Array<{ close(): void }> = [];

function createClient(handlers: P2pSignalingEvents = eventHandlers()) {
  const client = createP2pSignalingClient('meeting-slug', 'participant-1', handlers, {
    createWebSocket: (url) => new FakeWebSocket(url),
    location: pageLocation
  });
  clients.push(client);
  return client;
}

/** Connects and returns after the server has delivered the welcome. */
async function connectClient(client = createClient()): Promise<FakeWebSocket> {
  const connected = client.connect();
  const socket = lastSocket();
  socket.open();
  socket.message({ type: 'welcome', peers: [] });
  await connected;
  return socket;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  for (const client of clients) client.close();
  clients.length = 0;
  vi.useRealTimers();
});

describe('p2p signaling client', () => {
  it('builds the wss endpoint from the current page origin', async () => {
    const client = createClient();
    const connected = client.connect();

    expect(lastSocket().url).toBe('wss://meet.example.test/api/v1/meetings/meeting-slug/p2p');
    lastSocket().open();
    expect(lastSocket().sent[0]).toEqual({ type: 'hello', participantIdentity: 'participant-1' });
    lastSocket().message({ type: 'welcome', peers: [] });
    await connected;
  });

  it('uses ws on http pages', () => {
    expect(buildP2pSignalingUrl('meeting-slug', { protocol: 'http:', host: 'meet.example.test' }))
      .toBe('ws://meet.example.test/api/v1/meetings/meeting-slug/p2p');
  });

  it('resolves connect() once the server welcomes the client with the roster', async () => {
    const handlers = eventHandlers();
    const client = createClient(handlers);
    const connected = client.connect();
    const socket = lastSocket();
    socket.open();
    socket.message({
      type: 'welcome',
      peers: [{ identity: 'p2', nickname: 'Bob' }, { identity: 'p3', nickname: 'Carol' }]
    });
    await connected;

    expect(handlers.onWelcome).toHaveBeenCalledWith([
      { identity: 'p2', nickname: 'Bob' },
      { identity: 'p3', nickname: 'Carol' }
    ]);
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it('strips the forwarded sender envelope and routes messages to the matching callbacks', async () => {
    const handlers = eventHandlers();
    const socket = await connectClient(createClient(handlers));
    const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0';

    socket.message({ type: 'offer', to: 'participant-1', sdp, from: 'sharer' });
    socket.message({ type: 'answer', to: 'participant-1', sdp, from: 'sharer' });
    socket.message({ type: 'ice', to: 'participant-1', candidate: 'candidate:1', from: 'sharer' });
    socket.message({ type: 'ice', to: 'participant-1', candidate: null, from: 'sharer' });
    socket.message({ type: 'media-ready', to: 'participant-1', from: 'viewer' });
    socket.message({ type: 'bye', to: 'participant-1', from: 'sharer' });
    socket.message({ type: 'bye', to: 'participant-1', reason: 'stopped', from: 'sharer' });
    socket.message({ type: 'peer-joined', peer: { identity: 'p2', nickname: 'Bob' } });
    socket.message({ type: 'peer-left', peer: { identity: 'p2' } });
    socket.message({ type: 'pong' });
    socket.message({ type: 'share-gone', reason: 'sharer left' });
    socket.message({ type: 'error', code: 'RATE_LIMITED', message: 'slow down' });

    expect(handlers.onOffer).toHaveBeenCalledWith('sharer', sdp);
    expect(handlers.onAnswer).toHaveBeenCalledWith('sharer', sdp);
    expect(handlers.onIce).toHaveBeenCalledWith('sharer', 'candidate:1');
    expect(handlers.onIce).toHaveBeenCalledWith('sharer', null);
    expect(handlers.onMediaReady).toHaveBeenCalledWith('viewer');
    expect(handlers.onBye).toHaveBeenCalledWith('sharer', undefined);
    expect(handlers.onBye).toHaveBeenCalledWith('sharer', 'stopped');
    expect(handlers.onPeerJoined).toHaveBeenCalledWith({ identity: 'p2', nickname: 'Bob' });
    expect(handlers.onPeerLeft).toHaveBeenCalledWith({ identity: 'p2' });
    expect(handlers.onShareGone).toHaveBeenCalledOnce();
    expect(handlers.onError).toHaveBeenCalledWith('RATE_LIMITED');
    expect(handlers.onOffer).toHaveBeenCalledOnce();
  });

  it('ignores forwarded signaling frames that lack a sender identity', async () => {
    const handlers = eventHandlers();
    const socket = await connectClient(createClient(handlers));

    socket.message({ type: 'offer', to: 'participant-1', sdp: 'sdp' });
    socket.message({ type: 'ice', to: 'participant-1', candidate: 'candidate:1' });

    expect(handlers.onOffer).not.toHaveBeenCalled();
    expect(handlers.onIce).not.toHaveBeenCalled();
  });

  it('ignores malformed and unrecognized frames', async () => {
    const handlers = eventHandlers();
    const socket = await connectClient(createClient(handlers));

    socket.onmessage?.({ data: 'not json' });
    socket.message({ type: 'warp-drive' });
    socket.message(null);

    expect(handlers.onPeerJoined).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it('pings the server every 25 seconds', async () => {
    const socket = await connectClient();

    expect(socket.sent).toEqual([{ type: 'hello', participantIdentity: 'participant-1' }]);
    vi.advanceTimersByTime(24_999);
    expect(socket.sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(socket.sent[1]).toEqual({ type: 'ping' });
    vi.advanceTimersByTime(25_000);
    expect(socket.sent[2]).toEqual({ type: 'ping' });
  });

  it('reconnects with exponential backoff and restores the roster from the new welcome', async () => {
    const handlers = eventHandlers();
    const client = createClient(handlers);
    const connected = client.connect();
    const first = lastSocket();
    first.open();
    first.message({ type: 'welcome', peers: [{ identity: 'p2', nickname: 'Bob' }] });
    await connected;
    expect(handlers.onWelcome).toHaveBeenCalledTimes(1);

    first.fail(4001);
    expect(FakeWebSocket.instances).toHaveLength(1); // no immediate reconnect
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = lastSocket();
    second.open();
    second.message({ type: 'welcome', peers: [] }); // server restarted: an empty roster is fine
    expect(handlers.onWelcome).toHaveBeenCalledTimes(2);
    expect(handlers.onWelcome).toHaveBeenLastCalledWith([]);

    vi.advanceTimersByTime(25_000); // heartbeat is re-armed on the new socket
    expect(second.sent[1]).toEqual({ type: 'ping' });

    second.fail(4001);
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    const third = lastSocket();
    third.open();
    third.message({
      type: 'welcome',
      peers: [{ identity: 'p2', nickname: 'Bob' }, { identity: 'p3', nickname: 'Carol' }]
    });
    expect(handlers.onWelcome).toHaveBeenLastCalledWith([
      { identity: 'p2', nickname: 'Bob' },
      { identity: 'p3', nickname: 'Carol' }
    ]);
  });

  it('doubles the reconnect delay up to the 30-second cap', async () => {
    const client = createClient();
    const connected = client.connect();
    const first = lastSocket();
    first.open();
    first.message({ type: 'welcome', peers: [] });
    await connected;
    first.fail();

    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    delays.forEach((delay, index) => {
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(index + 1);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(index + 2);
      lastSocket().fail();
    });
    expect(FakeWebSocket.instances).toHaveLength(delays.length + 1);
  });

  it('rejects connect() when the first connection closes before the welcome', async () => {
    const client = createClient();
    const connected = client.connect();
    lastSocket().fail();

    await expect(connected).rejects.toThrow('P2P signaling');
  });

  it('sends signaling messages as typed JSON frames', async () => {
    const client = createClient();
    const socket = await connectClient(client);

    client.sendOffer('sharer', 'offer-sdp');
    client.sendAnswer('sharer', 'answer-sdp');
    client.sendIce('sharer', 'candidate:1');
    client.sendIce('sharer', null);
    client.sendMediaReady('sharer');
    client.sendBye('sharer');
    client.sendBye('sharer', 'leaving');

    expect(socket.sent).toEqual([
      { type: 'hello', participantIdentity: 'participant-1' },
      { type: 'offer', to: 'sharer', sdp: 'offer-sdp' },
      { type: 'answer', to: 'sharer', sdp: 'answer-sdp' },
      { type: 'ice', to: 'sharer', candidate: 'candidate:1' },
      { type: 'ice', to: 'sharer', candidate: null },
      { type: 'media-ready', to: 'sharer' },
      { type: 'bye', to: 'sharer' },
      { type: 'bye', to: 'sharer', reason: 'leaving' }
    ]);
  });

  it('drops outbound signaling while no socket is open', () => {
    const client = createClient();

    client.sendOffer('sharer', 'sdp');
    client.sendBye('sharer');

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('stops reconnecting once close() is called', async () => {
    const handlers = eventHandlers();
    const client = createClient(handlers);
    const socket = await connectClient(client);
    socket.fail(); // schedules a reconnect in 1s
    client.close();

    vi.advanceTimersByTime(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(handlers.onWelcome).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect when the server closes the socket after close()', async () => {
    const client = createClient();
    const socket = await connectClient(client);
    client.close();
    socket.fail(1006);

    vi.advanceTimersByTime(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('ignores connect() after close()', async () => {
    const client = createClient();
    await connectClient(client);
    client.close();

    await expect(client.connect()).resolves.toBeUndefined();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
