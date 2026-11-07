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
import { hashSessionToken } from '../src/security/session-token.js';
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

  it('admits exactly three concurrent creates and frees a slot after one ends', async () => {
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, index) =>
      service.createMeeting({ name: `Meeting ${index}`, meetingPassword: 'join-secret' })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'MEETING_LIMIT_REACHED' } }]);
    const rooms = repo.listNonTerminal();
    await service.endMeeting(rooms[0]!.slug);
    await expect(service.createMeeting({ name: 'Replacement' })).resolves.toMatchObject({ name: 'Replacement' });
    expect(repo.countNonTerminal()).toBe(3);
  });

  it('isolates unavailable rooms in the open list and still counts their admission slot', async () => {
    const rooms = await Promise.all(['A', 'B', 'C'].map(name => service.createMeeting({ name })));
    media.unavailableMeetings.add(rooms[1]!.id);
    expect(await service.getOpenMeetingSummaries()).toMatchObject([
      { name: 'A', isFull: false }, { name: 'B', unavailable: true }, { name: 'C', isFull: false }
    ]);
    expect(repo.countNonTerminal()).toBe(3);
    await expect(service.createMeeting({ name: 'Fourth' })).rejects.toMatchObject({ code: 'MEETING_LIMIT_REACHED' });
  });

  it('continues cleaning other open rooms after one media query fails', async () => {
    const rooms = await Promise.all(['A', 'B', 'C'].map(name => service.createMeeting({ name })));
    for (const room of rooms) repo.updateMeetingLifecycle(room.id, { status: 'grace', emptySince: clock.now(), endedAt: null });
    clock.set(clock.now() + EMPTY_GRACE_MS);
    media.unavailableMeetings.add(rooms[0]!.id);
    let failures = 0;
    const cleaned = await service.runCleanup(() => { failures++; });
    expect(failures).toBe(1);
    expect(cleaned).toEqual(expect.arrayContaining([rooms[1]!.slug, rooms[2]!.slug]));
    expect(repo.listNonTerminal().map(room => room.id)).toEqual([rooms[0]!.id]);
    expect(media.closedMeetings).not.toContain(rooms[0]!.id);
  });

  it('expires every hard-TTL room even when media occupancy is unavailable', async () => {
    const rooms = await Promise.all(['A', 'B', 'C'].map(name => service.createMeeting({ name })));
    rooms.forEach(room => media.unavailableMeetings.add(room.id));
    clock.set(rooms[0]!.expiresAt);
    await expect(service.runCleanup()).resolves.toEqual(expect.arrayContaining(rooms.map(room => room.slug)));
    expect(repo.countNonTerminal()).toBe(0);
  });

  it('reports rooms expired by an open-list request to the next signaling cleanup pass', async () => {
    const rooms = await Promise.all(['A', 'B', 'C'].map(name => service.createMeeting({ name })));
    clock.set(rooms[0]!.expiresAt);
    await expect(service.getOpenMeetingSummaries()).resolves.toEqual([]);
    expect(repo.findTerminalMeetingsAwaitingMediaCleanup()).toEqual([]);
    await expect(service.runCleanup()).resolves.toEqual(rooms.map(room => room.slug));
    await expect(service.runCleanup()).resolves.toEqual([]);
  });

  it('keeps the legacy current response singular and advances after its first room expires', async () => {
    const first = await service.createMeeting({ name: 'First' });
    clock.set(clock.now() + 1_000);
    const second = await service.createMeeting({ name: 'Second' });
    await expect(service.getCurrentMeetingSummary()).resolves.toMatchObject({ slug: first.slug });
    clock.set(first.expiresAt);
    await expect(service.getCurrentMeetingSummary()).resolves.toEqual({ slug: second.slug, name: 'Second', status: 'created', requiresPassword: false, isFull: false });
  });

  it('returns only the synchronized current non-terminal meeting', async () => {
    const meeting = await service.createMeeting({ name: 'Daily', meetingPassword: 'join-secret' });

    await expect(service.getCurrentMeetingSummary()).resolves.toEqual({
      slug: meeting.slug,
      name: 'Daily',
      status: 'created',
      requiresPassword: true,
      isFull: false
    });

    await service.endMeeting(meeting.slug);
    await expect(service.getCurrentMeetingSummary()).resolves.toBeNull();
  });

  it('returns null when no non-terminal meeting exists', async () => {
    await expect(service.getCurrentMeetingSummary()).resolves.toBeNull();
  });

  it('rejects an empty meeting password at creation time', async () => {
    await expect(service.createMeeting({ name: 'Daily', meetingPassword: '' }))
      .rejects.toThrow('Meeting password must not be empty');
  });

  it('rejects joining at the exact 24 hour expiry boundary', async () => {
    const meeting = await service.createMeeting({ name: 'Daily' });
    clock.set(meeting.createdAt + MEETING_TTL_MS);

    await expect(service.joinMeeting(meeting.slug, { nickname: 'Ada' }))
      .rejects.toMatchObject({ code: 'MEETING_EXPIRED' });
  });

  it('rejects a join that expires while awaiting final occupancy without issuing side effects', async () => {
    const meeting = await service.createMeeting({ name: 'Daily' });
    clock.set(meeting.expiresAt - 1);
    media.onListParticipants = (call) => {
      if (call === 2) clock.set(meeting.expiresAt);
    };

    await expect(service.joinMeeting(meeting.slug, { nickname: 'Ada' }))
      .rejects.toMatchObject({ code: 'MEETING_EXPIRED' });

    expect(media.issuedTokens).toEqual([]);
    expect(db.prepare('SELECT identity FROM join_reservations').all()).toEqual([]);
    expect(db.prepare('SELECT identity FROM participant_sessions').all()).toEqual([]);
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

  it('stores a participant session token only as a SHA-256 hash', async () => {
    const meeting = await service.createMeeting({ name: 'Daily' });
    const joined = await service.joinMeeting(meeting.slug, { nickname: 'Ada' });
    const stored = db.prepare('SELECT token_hash FROM participant_sessions WHERE identity = ?')
      .get(joined.participantIdentity) as { token_hash: string };

    expect(stored.token_hash).toBe(hashSessionToken(joined.participantSessionToken));
    expect(stored.token_hash).not.toBe(joined.participantSessionToken);
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

  it('clears a departing participant share grant even when no screen track was published', async () => {
    const meeting = await service.createMeeting({ name: 'Daily' });
    const joined = await service.joinMeeting(meeting.slug, { nickname: 'Ada' });
    const current = repo.findBySlug(meeting.slug);
    if (!current) throw new Error('meeting fixture missing');
    expect(repo.trySetShareIdentity(current.id, current.version, joined.participantIdentity)).toEqual({ ok: true });

    await service.leaveMeeting(meeting.slug, joined.participantIdentity);

    expect(repo.findBySlug(meeting.slug)?.shareIdentity).toBeNull();
  });

  it('retains a departing participant share grant until media removal succeeds on retry', async () => {
    const meeting = await service.createMeeting({ name: 'Daily' });
    const joined = await service.joinMeeting(meeting.slug, { nickname: 'Ada' });
    const current = repo.findBySlug(meeting.slug);
    if (!current) throw new Error('meeting fixture missing');
    expect(repo.trySetShareIdentity(current.id, current.version, joined.participantIdentity)).toEqual({ ok: true });
    media.removeFailuresRemaining = 1;

    await expect(service.leaveMeeting(meeting.slug, joined.participantIdentity))
      .rejects.toThrow('media unavailable');

    expect(repo.findParticipantSessionByIdentity(joined.participantIdentity, clock.now())).toBeNull();
    expect(repo.findBySlug(meeting.slug)?.shareIdentity).toBe(joined.participantIdentity);

    await service.leaveMeeting(meeting.slug, joined.participantIdentity);

    expect(media.removeAttempts).toBe(2);
    expect(repo.findBySlug(meeting.slug)?.shareIdentity).toBeNull();
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

  it('ends the meeting even when the media close fails and retries the close during cleanup', async () => {
    const meeting = await service.createMeeting({ name: 'Daily' });
    media.closeFailuresRemaining = 1;

    // The database transition is committed; a transient LiveKit failure must
    // not fail the host's end request, so the meeting never appears to keep
    // running after a successful end.
    await service.endMeeting(meeting.slug);
    await expect(service.joinMeeting(meeting.slug, { nickname: 'Ada' }))
      .rejects.toMatchObject({ code: 'MEETING_EXPIRED' });
    expect(media.closedMeetings).toEqual([]); // the first close attempt failed

    const restarted = new MeetingService({
      repository: repo, media, passwords: new FakePasswordHasher(), clock, ids, config
    });
    await expect(restarted.runCleanup()).resolves.toContain(meeting.slug);
    expect(media.closeAttempts).toBe(2);
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
  reservationTtlMs: 60_000, maxParticipants: 5,
  p2pStunUrls: ['stun:stun.example.test:3478']
};

class FakePasswordHasher implements PasswordHasher {
  async hash(value: string): Promise<string> { return `hash:${value}`; }
  async verify(hash: string, value: string): Promise<boolean> { return hash === `hash:${value}`; }
}

class FakeMediaService implements MediaService {
  readonly identities = new Map<string, string[]>();
  readonly unavailableMeetings = new Set<string>();
  readonly closedMeetings: string[] = [];
  readonly issuedTokens: string[] = [];
  closeFailuresRemaining = 0;
  closeAttempts = 0;
  removeFailuresRemaining = 0;
  removeAttempts = 0;
  onListParticipants?: (call: number) => void;
  private listCalls = 0;

  async listParticipantIdentities(meetingId: string): Promise<string[]> {
    if (this.unavailableMeetings.has(meetingId)) throw new Error('media unavailable');
    const call = ++this.listCalls;
    await Promise.resolve();
    this.onListParticipants?.(call);
    return this.identities.get(meetingId) ?? [];
  }

  async issueParticipantToken(input: { identity: string }): Promise<string> {
    this.issuedTokens.push(input.identity);
    return `livekit-${input.identity}`;
  }

  async removeParticipant(meetingId: string, identity: string): Promise<void> {
    this.removeAttempts++;
    if (this.removeFailuresRemaining > 0) {
      this.removeFailuresRemaining--;
      throw new Error('media unavailable');
    }
    this.identities.set(meetingId, (this.identities.get(meetingId) ?? []).filter((value) => value !== identity));
  }

  async closeMeeting(meetingId: string): Promise<void> {
    this.closeAttempts++;
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining--;
      throw new Error('media unavailable');
    }
    this.closedMeetings.push(meetingId);
    this.identities.delete(meetingId);
  }
}
