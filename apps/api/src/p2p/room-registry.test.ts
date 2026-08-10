import { describe, expect, it } from 'vitest';

import { P2pRoomRegistry, type P2pSocket } from './room-registry.js';

class FakeSocket implements P2pSocket {
  readonly sent: string[] = [];
  readonly closeCalls: Array<number | undefined> = [];

  send(raw: string): void {
    this.sent.push(raw);
  }

  close(code?: number): void {
    this.closeCalls.push(code);
  }

  messages(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw));
  }
}

describe('P2pRoomRegistry', () => {
  it('tracks peers per room and lists them in join order', () => {
    const registry = new P2pRoomRegistry();
    registry.join('meeting-a', 'ada', 'Ada', new FakeSocket());
    registry.join('meeting-a', 'bob', 'Bob', new FakeSocket());
    registry.join('meeting-b', 'ada', 'Ada', new FakeSocket());

    expect(registry.listPeers('meeting-a')).toEqual([
      { identity: 'ada', nickname: 'Ada' },
      { identity: 'bob', nickname: 'Bob' }
    ]);
    expect(registry.listPeers('meeting-b')).toEqual([{ identity: 'ada', nickname: 'Ada' }]);
    expect(registry.listPeers('empty-room')).toEqual([]);
  });

  it('sendTo delivers a JSON message to an online peer and returns false for an offline peer', () => {
    const registry = new P2pRoomRegistry();
    const target = new FakeSocket();
    registry.join('meeting-a', 'bob', 'Bob', target);

    expect(registry.sendTo('meeting-a', 'bob', { type: 'pong' })).toBe(true);
    expect(target.messages()).toEqual([{ type: 'pong' }]);
    expect(registry.sendTo('meeting-a', 'ghost', { type: 'pong' })).toBe(false);
  });

  it('broadcast sends to every peer except the excluded identity', () => {
    const registry = new P2pRoomRegistry();
    const ada = new FakeSocket();
    const bob = new FakeSocket();
    const carol = new FakeSocket();
    registry.join('meeting-a', 'ada', 'Ada', ada);
    registry.join('meeting-a', 'bob', 'Bob', bob);
    registry.join('meeting-a', 'carol', 'Carol', carol);

    registry.broadcast('meeting-a', { type: 'pong' }, 'bob');

    expect(ada.messages()).toEqual([{ type: 'pong' }]);
    expect(bob.messages()).toEqual([]);
    expect(carol.messages()).toEqual([{ type: 'pong' }]);
  });

  it('broadcastShareGone notifies every connected peer', () => {
    const registry = new P2pRoomRegistry();
    const ada = new FakeSocket();
    const bob = new FakeSocket();
    registry.join('meeting-a', 'ada', 'Ada', ada);
    registry.join('meeting-a', 'bob', 'Bob', bob);

    registry.broadcastShareGone('meeting-a');

    expect(ada.messages()).toEqual([{ type: 'share-gone', reason: 'share released' }]);
    expect(bob.messages()).toEqual([{ type: 'share-gone', reason: 'share released' }]);
  });

  it('broadcastShareGone accepts an explicit reason', () => {
    const registry = new P2pRoomRegistry();
    const ada = new FakeSocket();
    registry.join('meeting-a', 'ada', 'Ada', ada);

    registry.broadcastShareGone('meeting-a', 'meeting ended');

    expect(ada.messages()).toEqual([{ type: 'share-gone', reason: 'meeting ended' }]);
  });

  it('leave removes the peer, reports whether it removed, and cleans up empty rooms', () => {
    const registry = new P2pRoomRegistry();
    const socket = new FakeSocket();
    registry.join('meeting-a', 'ada', 'Ada', socket);

    expect(registry.leave('meeting-a', 'ada', socket)).toBe(true);
    expect(registry.listPeers('meeting-a')).toEqual([]);
    expect(registry.leave('meeting-a', 'ada', socket)).toBe(false);
  });

  it('leave does not remove an entry that was replaced by a newer socket', () => {
    const registry = new P2pRoomRegistry();
    const stale = new FakeSocket();
    const fresh = new FakeSocket();
    registry.join('meeting-a', 'ada', 'Ada', stale);
    registry.join('meeting-a', 'ada', 'Ada', fresh);

    expect(registry.leave('meeting-a', 'ada', stale)).toBe(false);
    expect(registry.listPeers('meeting-a')).toEqual([{ identity: 'ada', nickname: 'Ada' }]);
    expect(registry.leave('meeting-a', 'ada', fresh)).toBe(true);
    expect(registry.listPeers('meeting-a')).toEqual([]);
  });
});
