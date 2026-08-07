import type Database from 'better-sqlite3';

import type { MeetingRepository } from './meeting-repository.js';
import type {
  JoinReservation,
  MeetingRecord,
  MeetingStatus,
  NewMeetingRecord,
  ParticipantSession,
  ShareUpdateResult
} from './models.js';

interface MeetingRow {
  id: string;
  slug: string;
  name: string;
  password_hash: string | null;
  status: MeetingStatus;
  share_identity: string | null;
  created_at: number;
  expires_at: number;
  empty_since: number | null;
  ended_at: number | null;
  media_closed_at: number | null;
  version: number;
}

interface ReservationRow {
  identity: string;
  meeting_id: string;
  nickname: string;
  issued_at: number;
  expires_at: number;
}

export class SqliteMeetingRepository implements MeetingRepository {
  public constructor(private readonly db: Database.Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createMeeting(input: NewMeetingRecord): MeetingRecord {
    this.db.prepare(`
      INSERT INTO meetings (
        id, slug, name, password_hash, status, share_identity,
        created_at, expires_at, empty_since, ended_at, version
      ) VALUES (?, ?, ?, ?, 'created', NULL, ?, ?, NULL, NULL, 0)
    `).run(
      input.id,
      input.slug,
      input.name,
      input.passwordHash,
      input.createdAt,
      input.expiresAt
    );

    return this.requireMeetingById(input.id);
  }

  findBySlug(slug: string): MeetingRecord | null {
    const row = this.db.prepare('SELECT * FROM meetings WHERE slug = ?').get(slug) as MeetingRow | undefined;
    return row ? toMeetingRecord(row) : null;
  }

  findNonTerminal(): MeetingRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM meetings
      WHERE status IN ('created', 'active', 'grace')
    `).get() as MeetingRow | undefined;
    return row ? toMeetingRecord(row) : null;
  }

  findTerminalMeetingsAwaitingMediaCleanup(): MeetingRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM meetings
      WHERE status IN ('ended', 'expired') AND media_closed_at IS NULL
      ORDER BY ended_at, id
    `).all() as MeetingRow[];
    return rows.map(toMeetingRecord);
  }

  updateMeetingLifecycle(meetingId: string, input: {
    status: MeetingStatus;
    emptySince: number | null;
    endedAt: number | null;
  }): MeetingRecord {
    this.db.prepare(`
      UPDATE meetings
      SET status = ?, empty_since = ?, ended_at = ?, version = version + 1
      WHERE id = ?
    `).run(input.status, input.emptySince, input.endedAt, meetingId);

    return this.requireMeetingById(meetingId);
  }

  markMeetingMediaClosed(meetingId: string, at: number): void {
    this.db.prepare(`
      UPDATE meetings
      SET media_closed_at = ?
      WHERE id = ? AND media_closed_at IS NULL
    `).run(at, meetingId);
  }

  listLiveReservations(meetingId: string, now: number): JoinReservation[] {
    const rows = this.db.prepare(`
      SELECT identity, meeting_id, nickname, issued_at, expires_at
      FROM join_reservations
      WHERE meeting_id = ? AND expires_at > ?
      ORDER BY issued_at, identity
    `).all(meetingId, now) as ReservationRow[];

    return rows.map(toJoinReservation);
  }

  insertReservation(value: JoinReservation): void {
    this.db.prepare(`
      INSERT INTO join_reservations (identity, meeting_id, nickname, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(value.identity, value.meetingId, value.nickname, value.issuedAt, value.expiresAt);
  }

  deleteReservation(identity: string): void {
    this.db.prepare('DELETE FROM join_reservations WHERE identity = ?').run(identity);
  }

  upsertParticipantSession(value: ParticipantSession): void {
    this.db.prepare(`
      INSERT INTO participant_sessions (
        identity, meeting_id, nickname, token_hash, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity) DO UPDATE SET
        meeting_id = excluded.meeting_id,
        nickname = excluded.nickname,
        token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        revoked_at = excluded.revoked_at
    `).run(
      value.identity,
      value.meetingId,
      value.nickname,
      value.tokenHash,
      value.expiresAt,
      value.revokedAt
    );
  }

  revokeParticipantSession(identity: string, at: number): void {
    this.db.prepare(`
      UPDATE participant_sessions
      SET revoked_at = ?
      WHERE identity = ?
    `).run(at, identity);
  }

  revokeParticipantSessionsForMeeting(meetingId: string, at: number): void {
    this.db.prepare(`
      UPDATE participant_sessions
      SET revoked_at = ?
      WHERE meeting_id = ? AND revoked_at IS NULL
    `).run(at, meetingId);
  }

  trySetShareIdentity(meetingId: string, version: number, identity: string | null): ShareUpdateResult {
    const result = this.db.prepare(`
      UPDATE meetings
      SET share_identity = ?, version = version + 1
      WHERE id = ? AND version = ?
    `).run(identity, meetingId, version);

    return result.changes === 1 ? { ok: true } : { ok: false, reason: 'VERSION_CONFLICT' };
  }

  markWebhookProcessed(eventId: string, at: number): boolean {
    const result = this.db.prepare(`
      INSERT INTO processed_webhooks (event_id, processed_at)
      VALUES (?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `).run(eventId, at);

    return result.changes === 1;
  }

  private requireMeetingById(id: string): MeetingRecord {
    const row = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as MeetingRow | undefined;
    if (!row) throw new Error(`Meeting ${id} was not created`);
    return toMeetingRecord(row);
  }
}

function toMeetingRecord(row: MeetingRow): MeetingRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    passwordHash: row.password_hash,
    status: row.status,
    shareIdentity: row.share_identity,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    emptySince: row.empty_since,
    endedAt: row.ended_at,
    mediaClosedAt: row.media_closed_at,
    version: row.version
  };
}

function toJoinReservation(row: ReservationRow): JoinReservation {
  return {
    identity: row.identity,
    meetingId: row.meeting_id,
    nickname: row.nickname,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at
  };
}
