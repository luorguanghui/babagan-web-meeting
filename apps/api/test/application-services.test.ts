import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import type { IceServer, MediaService, PublishSource } from '../src/livekit/media-service.js';
import { SqliteMeetingRepository } from '../src/repositories/sqlite-meeting-repository.js';
import type { HostSession, ParticipantSession } from '../src/repositories/models.js';
import { hashSessionToken } from '../src/security/session-token.js';
import { HostApplicationService } from '../src/services/host-application-service.js';
import { MeetingService, type IdGenerator, type PasswordHasher } from '../src/services/meeting-service.js';
import { ParticipantApplicationService } from '../src/services/participant-application-service.js';
import { KeyedMutex } from '../src/services/keyed-mutex.js';
import { FakeClock } from './fakes/fake-clock.js';

describe('host and participant application services', () => {
  let directory: string;
  let db: Database.Database;
  let repository: SqliteMeetingRepository;
  let clock: FakeClock;
  let ids: QueueIds;
  let media: ServiceMediaFake;
  let meetings: MeetingService;
  let hosts: HostApplicationService;
  let participants: ParticipantApplicationService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'meeting-app-services-'));
    db = createDatabase(join(directory, 'meetings.sqlite'));
    migrate(db);
    repository = new SqliteMeetingRepository(db);
    clock = new FakeClock(1_000);
    ids = new QueueIds();
    media = new ServiceMediaFake();
    const mutex = new KeyedMutex();
    meetings = new MeetingService({
      repository,
      media: {
        listParticipantIdentities: async (meetingId) => [...await media.listParticipantIdentities(meetingId)],
        issueParticipantToken: (input) => media.issueToken(input),
        removeParticipant: (meetingId, identity) => media.removeParticipant(meetingId, identity),
        closeMeeting: (meetingId) => media.deleteRoom(meetingId)
      },
      passwords: new LiteralPasswordHasher(),
      clock,
      ids,
      config,
      mutex
    });
    hosts = new HostApplicationService({
      repository,
      meetings,
      media,
      passwords: new LiteralPasswordHasher(),
      clock,
      ids,
      config,
      mutex
    });
    participants = new ParticipantApplicationService({ repository, media, clock, ids, config });
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates nothing when the admin password is wrong', async () => {
    await expect(hosts.createMeeting({ adminPassword: 'wrong', name: 'Daily' }))
      .rejects.toMatchObject({ code: 'ADMIN_AUTH_FAILED' });

    expect(repository.findNonTerminal()).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS count FROM host_sessions').get()).toEqual({ count: 0 });
  });

  it('stores only the hash of the successful create host token', async () => {
    const created = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
    const stored = db.prepare('SELECT token_hash FROM host_sessions').get() as { token_hash: string };

    expect(created.rawHostToken).toBe('raw-host-token');
    expect(stored.token_hash).toBe(hashSessionToken('raw-host-token'));
    expect(stored.token_hash).not.toBe(created.rawHostToken);
  });

  it('ends and audits a meeting with the administrator password without creating host authority', async () => {
    const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
    await meetings.joinMeeting(meeting.slug, { nickname: 'Ada' });

    await hosts.endMeetingWithAdminPassword(meeting.slug, 'admin-secret');

    expect(repository.findBySlug(meeting.slug)?.status).toBe('ended');
    expect(db.prepare('SELECT event_type, meeting_id FROM audit_events WHERE event_type = ?')
      .get('meeting_ended_by_admin_password')).toEqual({
      event_type: 'meeting_ended_by_admin_password', meeting_id: meeting.id
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM host_sessions WHERE revoked_at IS NULL').get())
      .toEqual({ count: 0 });
  });

  it('does not end a meeting when the administrator password is wrong', async () => {
    const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });

    await expect(hosts.endMeetingWithAdminPassword(meeting.slug, 'wrong'))
      .rejects.toMatchObject({ code: 'ADMIN_AUTH_FAILED' });
    expect(repository.findBySlug(meeting.slug)?.status).toBe('created');
  });

  it('rejects a host session scoped to another meeting', async () => {
    const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });

    await expect(hosts.endMeeting({ ...activeHost(meeting.id), meetingId: 'other-meeting' }, meeting.slug))
      .rejects.toMatchObject({ name: 'SessionAuthenticationError' });
  });

  it('revokes a participant session before removing that participant from media', async () => {
    const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
    const joined = await meetings.joinMeeting(meeting.slug, { nickname: 'Ada' });
    media.onRemove = (identity) => {
      expect(repository.findParticipantSessionByTokenHash(
        hashSessionToken(joined.participantSessionToken), clock.now()
      )).toBeNull();
      expect(identity).toBe(joined.participantIdentity);
    };

    await hosts.kickParticipant(activeHost(meeting.id), meeting.slug, joined.participantIdentity);

    expect(media.removed).toEqual([joined.participantIdentity]);
    expect(db.prepare('SELECT event_type, meeting_id, subject_id FROM audit_events').all()).toEqual([{
      event_type: 'participant_kicked', meeting_id: meeting.id, subject_id: joined.participantIdentity
    }]);
  });

  it('serializes share grants behind an in-flight join on the shared meeting mutex', async () => {
    const sharedMutex = new KeyedMutex();
    meetings = new MeetingService({
      repository,
      media: {
        listParticipantIdentities: async (meetingId) => [...await media.listParticipantIdentities(meetingId)],
        issueParticipantToken: (input) => media.issueToken(input),
        removeParticipant: (meetingId, identity) => media.removeParticipant(meetingId, identity),
        closeMeeting: (meetingId) => media.deleteRoom(meetingId)
      },
      passwords: new LiteralPasswordHasher(), clock, ids, config, mutex: sharedMutex
    });
    hosts = new HostApplicationService({
      repository, meetings, media, passwords: new LiteralPasswordHasher(),
      clock, ids, config, mutex: sharedMutex
    });
    const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
    const tokenGate = deferred<void>();
    media.tokenGate = tokenGate;
    const join = meetings.joinMeeting(meeting.slug, { nickname: 'Ada' });
    await media.tokenStarted;

    const grant = hosts.grantShare(activeHost(meeting.id), meeting.slug, 'participant-1');
    const early = await Promise.race([
      grant.then(() => 'settled', () => 'settled'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
    ]);
    expect(early).toBe('pending');

    tokenGate.resolve();
    await join;
    await expect(grant).resolves.toBeUndefined();
  });

  it('audits a scoped kick for a participant who is no longer present', async () => {
    const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });

    await hosts.kickParticipant(activeHost(meeting.id), meeting.slug, 'participant-gone');

    expect(media.removed).toEqual([]);
    expect(db.prepare('SELECT event_type, meeting_id, subject_id FROM audit_events').all()).toEqual([{
      event_type: 'participant_kicked', meeting_id: meeting.id, subject_id: 'participant-gone'
    }]);
  });

  it('allows exactly one concurrent share grant to acquire the persisted lock', async () => {
    const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
    const first = await meetings.joinMeeting(meeting.slug, { nickname: 'Ada' });
    const second = await meetings.joinMeeting(meeting.slug, { nickname: 'Lin' });

    const results = await Promise.allSettled([
      hosts.grantShare(activeHost(meeting.id), meeting.slug, first.participantIdentity),
      hosts.grantShare(activeHost(meeting.id), meeting.slug, second.participantIdentity)
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected'))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: 'SHARE_ALREADY_ACTIVE' }) })]);
    expect(repository.findBySlug(meeting.slug)?.shareIdentity)
      .toBe(media.sourceUpdates[0]?.identity);
  });

  it('rolls back only the acquired share lock when media grant fails', async () => {
    const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
    const joined = await meetings.joinMeeting(meeting.slug, { nickname: 'Ada' });
    media.updateError = new Error('livekit unavailable');

    await expect(hosts.grantShare(activeHost(meeting.id), meeting.slug, joined.participantIdentity))
      .rejects.toMatchObject({ code: 'MEDIA_SERVICE_UNAVAILABLE' });

    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBeNull();
  });

  it('clears an acquired share lock after grant failure despite an intervening version update', async () => {
    const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
    const joined = await meetings.joinMeeting(meeting.slug, { nickname: 'Ada' });
    media.updateError = new Error('livekit unavailable');
    const didIncrementVersion = introduceVersionIncrementBeforeShareClear(meeting.id);

    await expect(hosts.grantShare(activeHost(meeting.id), meeting.slug, joined.participantIdentity))
      .rejects.toMatchObject({ code: 'MEDIA_SERVICE_UNAVAILABLE' });

    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBeNull();
    expect(didIncrementVersion()).toBe(true);
  });

  it('keeps the share lock when media downgrade fails during revoke', async () => {
    const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
    const joined = await meetings.joinMeeting(meeting.slug, { nickname: 'Ada' });
    await hosts.grantShare(activeHost(meeting.id), meeting.slug, joined.participantIdentity);
    media.updateError = new Error('livekit unavailable');

    await expect(hosts.revokeShare(activeHost(meeting.id), meeting.slug))
      .rejects.toMatchObject({ code: 'MEDIA_SERVICE_UNAVAILABLE' });

    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBe(joined.participantIdentity);
  });

  it('clears a share lock after successful revoke despite an intervening version update', async () => {
    const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
    const joined = await meetings.joinMeeting(meeting.slug, { nickname: 'Ada' });
    await hosts.grantShare(activeHost(meeting.id), meeting.slug, joined.participantIdentity);
    const didIncrementVersion = introduceVersionIncrementBeforeShareClear(meeting.id);

    await hosts.revokeShare(activeHost(meeting.id), meeting.slug);

    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBeNull();
    expect(didIncrementVersion()).toBe(true);
  });

  it('refreshes from participant session identity and lists only active connected sessions', async () => {
    const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
    const ada = await meetings.joinMeeting(meeting.slug, { nickname: 'Ada' });
    const lin = await meetings.joinMeeting(meeting.slug, { nickname: 'Lin' });
    const adaSession = requireParticipant(ada.participantSessionToken);
    media.identities.set(meeting.id, new Set([ada.participantIdentity, lin.participantIdentity, 'unknown']));
    await hosts.grantShare(activeHost(meeting.id), meeting.slug, ada.participantIdentity);
    repository.revokeParticipantSession(lin.participantIdentity, clock.now());

    await expect(participants.refreshToken({ ...adaSession, meetingId: 'other' }, meeting.slug))
      .rejects.toMatchObject({ name: 'SessionAuthenticationError' });
    await expect(participants.refreshToken(adaSession, meeting.slug)).resolves.toMatchObject({
      participantIdentity: ada.participantIdentity,
      participantName: 'Ada',
      permissions: { canPublishMicrophone: true, canShareScreen: true }
    });
    await expect(participants.listParticipants(adaSession, meeting.slug)).resolves.toEqual({
      participants: [{ identity: ada.participantIdentity, name: 'Ada', isSharing: true }]
    });
    expect(media.issued.at(-1)?.sources)
      .toEqual(['microphone', 'screen_share', 'screen_share_audio']);
  });

  function requireParticipant(rawToken: string): ParticipantSession {
    const session = repository.findParticipantSessionByTokenHash(hashSessionToken(rawToken), clock.now());
    if (!session) throw new Error('Expected active participant session');
    return session;
  }

  function introduceVersionIncrementBeforeShareClear(meetingId: string): () => boolean {
    const original = repository.clearShareIdentityIfMatches.bind(repository);
    let incremented = false;
    repository.clearShareIdentityIfMatches = (id, identity) => {
      if (id === meetingId && identity === 'participant-1') {
        repository.updateMeetingLifecycle(id, { status: 'active', emptySince: null, endedAt: null });
        incremented = true;
      }
      return original(id, identity);
    };
    return () => incremented;
  }
});

const config: AppConfig = {
  nodeEnv: 'test',
  publicBaseUrl: new URL('https://meet.example.test'),
  livekitUrl: new URL('wss://rtc.example.test'),
  livekitInternalUrl: new URL('ws://livekit.internal'),
  livekitApiKey: 'key', livekitApiSecret: 'secret', adminPasswordHash: 'hash:admin-secret',
  cookieSecret: 'a'.repeat(32), databasePath: ':memory:',
  meetingTtlMs: 86_400_000, emptyGraceMs: 600_000, reconnectGraceMs: 30_000,
  reservationTtlMs: 60_000, maxParticipants: 5
};

class LiteralPasswordHasher implements PasswordHasher {
  async hash(value: string): Promise<string> { return `hash:${value}`; }
  async verify(hash: string, value: string): Promise<boolean> { return hash === `hash:${value}`; }
}

class QueueIds implements IdGenerator {
  private uuidCount = 0;
  private participantCount = 0;
  private tokenCount = 0;

  uuid(): string { return this.uuidCount++ === 0 ? 'meeting-id' : `host-session-${this.uuidCount}`; }
  slug(): string { return 'unpredictable-meeting-slug-1234'; }
  token(): string { return this.tokenCount++ === 0 ? 'raw-host-token' : `participant-token-${this.tokenCount}`; }
  participantIdentity(): string { return `participant-${++this.participantCount}`; }
}

class ServiceMediaFake implements MediaService {
  readonly identities = new Map<string, Set<string>>();
  readonly issued: Array<{ meetingId: string; identity: string; nickname: string; sources?: PublishSource[] }> = [];
  readonly sourceUpdates: Array<{ identity: string; sources: PublishSource[] }> = [];
  readonly removed: string[] = [];
  updateError?: Error;
  onRemove?: (identity: string) => void;
  tokenGate?: ReturnType<typeof deferred<void>>;
  private tokenStartedResolver!: () => void;
  readonly tokenStarted = new Promise<void>((resolve) => { this.tokenStartedResolver = resolve; });

  async listParticipantIdentities(roomName: string): Promise<Set<string>> {
    return new Set(this.identities.get(roomName) ?? []);
  }

  async issueToken(input: { meetingId: string; identity: string; nickname: string; sources?: PublishSource[] }): Promise<string> {
    this.tokenStartedResolver();
    await this.tokenGate?.promise;
    this.issued.push({ ...input, sources: input.sources ? [...input.sources] : undefined });
    return `livekit:${input.identity}`;
  }

  async updateParticipantSources(_roomName: string, identity: string, sources: PublishSource[]): Promise<void> {
    if (this.updateError) throw this.updateError;
    this.sourceUpdates.push({ identity, sources: [...sources] });
  }

  async removeParticipant(_roomName: string, identity: string): Promise<void> {
    this.onRemove?.(identity);
    this.removed.push(identity);
  }

  async deleteRoom(): Promise<void> {}
  async ping(): Promise<void> {}
  async fetchIceServers(): Promise<IceServer[]> { return []; }
}

function activeHost(meetingId: string): HostSession {
  return {
    id: 'host-session', meetingId, tokenHash: hashSessionToken('raw-host-token'),
    createdAt: 1_000, expiresAt: 10_000, revokedAt: null
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}
