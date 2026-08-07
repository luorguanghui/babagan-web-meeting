import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import type { NewMeetingRecord } from '../src/repositories/models.js';
import { SqliteMeetingRepository } from '../src/repositories/sqlite-meeting-repository.js';

describe('SQLite meeting repository', () => {
  let directory: string;
  let db: Database.Database;
  let repo: SqliteMeetingRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'meeting-repository-'));
    db = createDatabase(join(directory, 'meetings.sqlite'));
    migrate(db);
    repo = new SqliteMeetingRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('migrates all persistence tables and enforces one non-terminal meeting', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;

    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'meetings', 'host_sessions', 'participant_sessions',
      'join_reservations', 'audit_events', 'processed_webhooks'
    ]));
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    repo.createMeeting(newMeeting());

    expect(() => repo.createMeeting(newMeeting({ id: 'meeting-2', slug: 'meeting-two' })))
      .toThrow(/UNIQUE constraint failed/);
  });

  it('finds a meeting by slug and finds the non-terminal meeting', () => {
    const meeting = repo.createMeeting(newMeeting());

    expect(repo.findBySlug(meeting.slug)).toEqual(meeting);
    expect(repo.findBySlug('missing')).toBeNull();
    expect(repo.findNonTerminal()).toEqual(meeting);
  });

  it('updates share identity only when the meeting version matches', () => {
    const meeting = repo.createMeeting(newMeeting());

    expect(repo.trySetShareIdentity(meeting.id, meeting.version, 'participant-1')).toEqual({ ok: true });
    expect(repo.trySetShareIdentity(meeting.id, meeting.version, 'participant-2'))
      .toEqual({ ok: false, reason: 'VERSION_CONFLICT' });
    expect(repo.findBySlug(meeting.slug)).toMatchObject({
      shareIdentity: 'participant-1',
      version: 1
    });
  });

  it('returns only unexpired reservations and can delete a reservation', () => {
    const meeting = repo.createMeeting(newMeeting());
    repo.insertReservation(reservation(meeting.id, 'expired', 9));
    repo.insertReservation(reservation(meeting.id, 'live', 11));

    expect(repo.listLiveReservations(meeting.id, 10)).toEqual([
      reservation(meeting.id, 'live', 11)
    ]);

    repo.deleteReservation('live');
    expect(repo.listLiveReservations(meeting.id, 10)).toEqual([]);
  });

  it('records and revokes a participant session', () => {
    const meeting = repo.createMeeting(newMeeting());
    repo.upsertParticipantSession({
      identity: 'participant-1',
      meetingId: meeting.id,
      nickname: 'Ada',
      tokenHash: 'participant-token-hash',
      expiresAt: 2_000,
      revokedAt: null
    });

    repo.revokeParticipantSession('participant-1', 1_500);

    expect(db.prepare('SELECT revoked_at FROM participant_sessions WHERE identity = ?')
      .get('participant-1')).toEqual({ revoked_at: 1_500 });
  });

  it('persists lifecycle transitions and revokes every meeting participant session', () => {
    const meeting = repo.createMeeting(newMeeting());
    repo.upsertParticipantSession({
      identity: 'participant-1', meetingId: meeting.id, nickname: 'Ada',
      tokenHash: 'one', expiresAt: 2_000, revokedAt: null
    });
    repo.upsertParticipantSession({
      identity: 'participant-2', meetingId: meeting.id, nickname: 'Lin',
      tokenHash: 'two', expiresAt: 2_000, revokedAt: null
    });

    expect(repo.updateMeetingLifecycle(meeting.id, {
      status: 'grace', emptySince: 1_500, endedAt: null
    })).toMatchObject({ status: 'grace', emptySince: 1_500, endedAt: null });
    repo.revokeParticipantSessionsForMeeting(meeting.id, 1_600);

    expect(db.prepare('SELECT identity, revoked_at FROM participant_sessions ORDER BY identity').all())
      .toEqual([
        { identity: 'participant-1', revoked_at: 1_600 },
        { identity: 'participant-2', revoked_at: 1_600 }
      ]);
  });

  it('finds terminal meetings awaiting media deletion and records a completed deletion', () => {
    const meeting = repo.createMeeting(newMeeting());
    repo.updateMeetingLifecycle(meeting.id, { status: 'ended', emptySince: null, endedAt: 1_500 });

    expect(repo.findTerminalMeetingsAwaitingMediaCleanup()).toMatchObject([{ id: meeting.id }]);
    repo.markMeetingMediaClosed(meeting.id, 1_600);
    expect(repo.findTerminalMeetingsAwaitingMediaCleanup()).toEqual([]);
  });

  it('records a webhook event only once', () => {
    expect(repo.markWebhookProcessed('event-1', 1_000)).toBe(true);
    expect(repo.markWebhookProcessed('event-1', 1_001)).toBe(false);
    expect(db.prepare('SELECT event_id, processed_at FROM processed_webhooks').all())
      .toEqual([{ event_id: 'event-1', processed_at: 1_000 }]);
  });

  it('rolls back repository writes when a transaction fails', () => {
    expect(() => repo.transaction(() => {
      repo.createMeeting(newMeeting());
      throw new Error('rollback');
    })).toThrow('rollback');

    expect(repo.findBySlug('meeting-one')).toBeNull();
  });
});

function newMeeting(overrides: Partial<NewMeetingRecord> = {}): NewMeetingRecord {
  return {
    id: 'meeting-1',
    slug: 'meeting-one',
    name: 'Weekly meeting',
    passwordHash: null,
    createdAt: 1_000,
    expiresAt: 2_000,
    ...overrides
  };
}

function reservation(meetingId: string, identity: string, expiresAt: number) {
  return {
    identity,
    meetingId,
    nickname: identity === 'live' ? 'Grace' : 'Lin',
    issuedAt: 1,
    expiresAt
  };
}
