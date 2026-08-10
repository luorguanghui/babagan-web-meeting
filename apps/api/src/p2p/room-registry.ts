import type { P2pServerMessage } from '@meeting/contracts';

/**
 * Minimal socket surface used by the registry and signaling sessions.
 * The HTTP route layer adapts the concrete WebSocket library to this
 * interface, keeping all room logic independent of the WS stack.
 */
export interface P2pSocket {
  send(raw: string): void;
  close(code?: number): void;
  on(event: 'message' | 'close' | 'error', listener: (value?: unknown) => void): void;
}

export interface P2pPeer {
  identity: string;
  nickname: string;
}

interface P2pRoomEntry {
  nickname: string;
  socket: P2pSocket;
}

/**
 * In-memory registry of connected P2P signaling sockets, grouped by meeting
 * slug. Room membership is intentionally not persisted: after a server
 * restart the tables are empty and clients recover the full peer list from
 * the `welcome` message (client-side Task 4).
 */
export class P2pRoomRegistry {
  private readonly rooms = new Map<string, Map<string, P2pRoomEntry>>();

  join(slug: string, identity: string, nickname: string, socket: P2pSocket): void {
    let room = this.rooms.get(slug);
    if (!room) {
      room = new Map();
      this.rooms.set(slug, room);
    }
    room.set(identity, { nickname, socket });
  }

  /**
   * Removes the entry for `identity` only when it still belongs to `socket`.
   * A reconnect with the same identity replaces the entry; the displaced
   * session's close event must not evict the newer connection.
   * Returns true when an entry was removed.
   */
  leave(slug: string, identity: string, socket: P2pSocket): boolean {
    const room = this.rooms.get(slug);
    if (!room) return false;
    const entry = room.get(identity);
    if (!entry || entry.socket !== socket) return false;
    room.delete(identity);
    if (room.size === 0) this.rooms.delete(slug);
    return true;
  }

  listPeers(slug: string): P2pPeer[] {
    const room = this.rooms.get(slug);
    if (!room) return [];
    return [...room.entries()].map(([identity, entry]) => ({
      identity,
      nickname: entry.nickname
    }));
  }

  /** Returns false when the target is not online in the room. */
  sendTo(slug: string, identity: string, message: P2pServerMessage): boolean {
    const entry = this.rooms.get(slug)?.get(identity);
    if (!entry) return false;
    entry.socket.send(JSON.stringify(message));
    return true;
  }

  broadcast(slug: string, message: P2pServerMessage, exceptIdentity?: string): void {
    const room = this.rooms.get(slug);
    if (!room) return;
    const raw = JSON.stringify(message);
    for (const [identity, entry] of room) {
      if (identity === exceptIdentity) continue;
      entry.socket.send(raw);
    }
  }

  /** Notifies every connected peer that the shared screen lock is gone. */
  broadcastShareGone(slug: string, reason = 'share released'): void {
    this.broadcast(slug, { type: 'share-gone', reason });
  }
}
