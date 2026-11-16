import type Database from 'better-sqlite3';

export interface MoqRelayRecord {
  name: string;
  createdAt: number;
  id?: string;
}

export interface MoqRelayJournal {
  list(): MoqRelayRecord[];
  save(relay: MoqRelayRecord): void;
  forget(name: string): void;
}

/** Stores management IDs only. An API restart invalidates its in-memory publications. */
export class SqliteMoqRelayJournal implements MoqRelayJournal {
  constructor(private readonly db: Database.Database, private readonly accountId: string) {}

  list(): MoqRelayRecord[] {
    const rows = this.db.prepare(
      'SELECT name, created_at, relay_id FROM screen_moq_relays WHERE account_id = ?'
    ).all(this.accountId) as { name: string; created_at: number; relay_id: string | null }[];
    return rows.map((row) => ({ name: row.name, createdAt: row.created_at, id: row.relay_id ?? undefined }));
  }

  save(relay: MoqRelayRecord): void {
    this.db.prepare(`
      INSERT INTO screen_moq_relays (account_id, name, created_at, relay_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (account_id, name) DO UPDATE SET relay_id = excluded.relay_id
    `).run(this.accountId, relay.name, relay.createdAt, relay.id ?? null);
  }

  forget(name: string): void {
    this.db.prepare('DELETE FROM screen_moq_relays WHERE account_id = ? AND name = ?').run(this.accountId, name);
  }
}
