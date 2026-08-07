import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EMPTY_GRACE_MS,
  MEETING_TTL_MS,
  RECONNECT_GRACE_MS,
  RESERVATION_TTL_MS,
  isWithinReconnectGrace,
  nextMeetingStatus
} from '../src/domain/time.js';
import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import type { AppConfig } from '../src/config.js';
import { SqliteMeetingRepository } from '../src/repositories/sqlite-meeting-repository.js';
import {
  MeetingService,
  type MediaService,
  type PasswordHasher
} from '../src/services/meeting-service.js';
import { FakeClock } from './fakes/fake-clock.js';
import { FakeIds } from './fakes/fake-ids.js';

describe('meeting lifecycle time rules', () => {
  it('expires a meeting at exactly 24 hours', () => {
    const createdAt = 1_000;

    expect(nextMeetingStatus({
      status: 'created',
      participantCount: 0,
      now: createdAt + MEETING_TTL_MS,
      expiresAt: createdAt + MEETING_TTL_MS,
      emptySince: null
    }).status).toBe('expired');
  });

  it('keeps an empty room in grace until exactly ten minutes have elapsed', () => {
    const emptySince = 1_000;

    expect(nextMeetingStatus({
      status: 'grace',
      participantCount: 0,
      now: emptySince + EMPTY_GRACE_MS - 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      emptySince
    }).status).toBe('grace');
    expect(nextMeetingStatus({
      status: 'grace',
      participantCount: 0,
      now: emptySince + EMPTY_GRACE_MS,
      expiresAt: Number.MAX_SAFE_INTEGER,
      emptySince
    }).status).toBe('ended');
  });

  it('keeps reconnect grace for strictly less than thirty seconds', () => {
    const disconnectedAt = 1_000;

    expect(isWithinReconnectGrace(disconnectedAt, disconnectedAt + RECONNECT_GRACE_MS - 1)).toBe(true);
    expect(isWithinReconnectGrace(disconnectedAt, disconnectedAt + RECONNECT_GRACE_MS)).toBe(false);
  });

  it('uses a sixty second reservation TTL', () => {
    expect(RESERVATION_TTL_MS).toBe(60_000);
  });
});

describe('MeetingService', () => {
  let directory: string;
  let db: Database.Database;
  let repo: SqliteMeetingRepository;
  let clock: FakeClock;
  let ids: FakeIds;
  let media: FakeMediaService;
  let service: MeetingService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'meeting-service-'));
    db = createDatabase(join(directory, 'meetings.sqlite'));
    migrate(db);
    repo = new SqliteMeetingRepository(db);
    clock = new FakeClock(1_000);
    ids = new FakeIds();
    media = new FakeMediaService();
    service = new MeetingService({ repository: repo, media, passwords: new FakePasswordHasher(), clock, ids, config });
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects creating a second non-terminal meeting', async () => {
    await service.createMeeting({ name: 'First' });

    await expect(service.createMeeting({ name: 'Second' }))
      .rejects.toMatchObject({ code: 'MEETING_ALREADY_ACTIVE' });
  });

  it('rejects joining at the exact 24 hour expiry boundary', async () => {
    const meeting = await service.createMeeting({ name: 'Daily' });
    clock.set(meeting.createdAt + MEETING_TTL_MS);

    await expect(service.joinMeeting(meeting.slug, { nickname: 'Ada' }))
      .rejects.toMatchObject({ code: 'MEETING_EXPIRED' });
  });

  it('serializes six simultaneous joins and reserves only five places', async () => {
    const meeting = await service.createMeeting({ name: 'Daily' });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => service.joinMeeting(meeting.slug, { nickname: `P${index + 1}` }))
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(service.getMeetingSummary(meeting.slug)).resolves.toMatchObject({ isFull: true });
  });

  it('expires reservations at exactly sixty seconds', async () => {
    const meeting = await service.createMeeting({ name: 'Daily' });
    await Promise.all(Array.from({ length: 5 }, (_, index) =>
      service.joinMeeting(meeting.slug, { nickname: `P${index + 1}` })
    ));
    clock.set(clock.now() + RESERVATION_TTL_MS);

    await expect(service.getMeetingSummary(meeting.slug)).resolves.toMatchObject({ isFull: false });
  });

  it('puts a departed final participant into ten-minute grace then ends at the boundary after restart', async () => {
    const meeting = await service.createMeeting({ name: 'Daily' });
    const joined = await service.joinMeeting(meeting.slug, { nickname: 'Ada' });
    await service.leaveMeeting(meeting.slug, joined.participantIdentity);
    const emptySince = clock.now();
    const restarted = new MeetingService({
      repository: repo, media, passwords: new FakePasswordHasher(), clock, ids, config
    });

    clock.set(emptySince + EMPTY_GRACE_MS - 1);
    await expect(restarted.runCleanup()).resolves.not.toContain(meeting.slug);
    clock.set(emptySince + EMPTY_GRACE_MS);
    await expect(restarted.runCleanup()).resolves.toContain(meeting.slug);
    await expect(restarted.getMeetingSummary(meeting.slug)).resolves.toMatchObject({ status: 'ended' });
  });

  it('revokes every participant session and closes media when ended', async () => {
    const meeting = await service.createMeeting({ name: 'Daily' });
    const first = await service.joinMeeting(meeting.slug, { nickname: 'Ada' });
    const second = await service.joinMeeting(meeting.slug, { nickname: 'Lin' });

    await service.endMeeting(meeting.slug);

    expect(media.closedMeetings).toEqual([meeting.id]);
    expect(db.prepare('SELECT revoked_at FROM participant_sessions ORDER BY identity').all())
      .toEqual([{ revoked_at: clock.now() }, { revoked_at: clock.now() }]);
    await expect(service.joinMeeting(meeting.slug, { nickname: 'Grace' }))
      .rejects.toMatchObject({ code: 'MEETING_EXPIRED' });
    expect([first.participantIdentity, second.participantIdentity]).toHaveLength(2);
  });
});

const config: AppConfig = {
  nodeEnv: 'test',
  publicBaseUrl: new URL('http://meet.example.test'),
  livekitUrl: new URL('wss://rtc.example.test'),
  livekitInternalUrl: new URL('ws://livekit.internal'),
  livekitApiKey: 'key', livekitApiSecret: 'secret', adminPasswordHash: 'hash',
  cookieSecret: 'a'.repeat(32), databasePath: ':memory:',
  meetingTtlMs: 86_400_000, emptyGraceMs: 600_000, reconnectGraceMs: 30_000,
  reservationTtlMs: 60_000, maxParticipants: 5
};

class FakePasswordHasher implements PasswordHasher {
  async hash(value: string): Promise<string> { return `hash:${value}`; }
  async verify(hash: string, value: string): Promise<boolean> { return hash === `hash:${value}`; }
}

class FakeMediaService implements MediaService {
  readonly identities = new Map<string, string[]>();
  readonly closedMeetings: string[] = [];

  async listParticipantIdentities(meetingId: string): Promise<string[]> {
    return this.identities.get(meetingId) ?? [];
  }

  async issueParticipantToken(input: { identity: string }): Promise<string> {
    return `livekit-${input.identity}`;
  }

  async removeParticipant(meetingId: string, identity: string): Promise<void> {
    this.identities.set(meetingId, (this.identities.get(meetingId) ?? []).filter((value) => value !== identity));
  }

  async closeMeeting(meetingId: string): Promise<void> {
    this.closedMeetings.push(meetingId);
    this.identities.delete(meetingId);
  }
}
