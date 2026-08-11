import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import type { MediaService, PublishSource } from '../src/livekit/media-service.js';
import type { HostSession } from '../src/repositories/models.js';
import { SqliteMeetingRepository } from '../src/repositories/sqlite-meeting-repository.js';
import { hashSessionToken } from '../src/security/session-token.js';
import { HostApplicationService } from '../src/services/host-application-service.js';
import { KeyedMutex } from '../src/services/keyed-mutex.js';
import { MeetingService, type IdGenerator, type PasswordHasher } from '../src/services/meeting-service.js';
import { FakeClock } from './fakes/fake-clock.js';

describe('host screen-share and meeting controls', () => {
  let directory: string;
  let db: Database.Database;
  let repository: SqliteMeetingRepository;
  let media: HostMediaFake;
  let meetings: MeetingService;
  let hosts: HostApplicationService;
  let clock: FakeClock;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'meeting-host-service-'));
    db = createDatabase(join(directory, 'meetings.sqlite'));
    migrate(db);
    repository = new SqliteMeetingRepository(db);
    media = new HostMediaFake();
    clock = new FakeClock(1_000);
    const ids = new QueueIds();
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
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('allows only one concurrent share grant and audits the winning target', async () => {
    const { meeting } = await createMeetingWithParticipants('Ada', 'Lin');

    const results = await Promise.allSettled([
      hosts.grantShare(activeHost(meeting.id), meeting.slug, 'participant-1'),
      hosts.grantShare(activeHost(meeting.id), meeting.slug, 'participant-2')
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toMatch(/^participant-[12]$/);
    expect(audits()).toEqual([{
      event_type: 'screen_share_granted',
      meeting_id: meeting.id,
      subject_id: repository.findBySlug(meeting.slug)?.shareIdentity,
      metadata_json: '{}'
    }]);
  });

  it('rejects a host session from another meeting before changing permissions', async () => {
    const { meeting } = await createMeetingWithParticipants('Ada');

    await expect(hosts.grantShare(
      { ...activeHost(meeting.id), meetingId: 'another-meeting' },
      meeting.slug,
      'participant-1'
    )).rejects.toMatchObject({ name: 'SessionAuthenticationError' });

    expect(media.sourceUpdates).toEqual([]);
    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBeNull();
  });

  it('rejects a target without an active meeting participant session', async () => {
    const { meeting } = await createMeetingWithParticipants();

    await expect(hosts.grantShare(activeHost(meeting.id), meeting.slug, 'missing-participant'))
      .rejects.toMatchObject({ code: 'SHARE_NOT_AUTHORIZED' });

    expect(media.sourceUpdates).toEqual([]);
    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBeNull();
  });

  it('atomically clears its matching lock and records a system error when permission update fails', async () => {
    const { meeting } = await createMeetingWithParticipants('Ada');
    media.updateError = new Error('LiveKit unavailable');

    await expect(hosts.grantShare(activeHost(meeting.id), meeting.slug, 'participant-1'))
      .rejects.toMatchObject({ code: 'MEDIA_SERVICE_UNAVAILABLE' });

    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBeNull();
    expect(audits()).toEqual([{
      event_type: 'system_error',
      meeting_id: meeting.id,
      subject_id: 'participant-1',
      metadata_json: '{"operation":"screen_share_grant"}'
    }]);
  });

  it('downgrades LiveKit before clearing a host-revoked share and audits the revoke', async () => {
    const { meeting } = await createMeetingWithParticipants('Ada');
    await hosts.grantShare(activeHost(meeting.id), meeting.slug, 'participant-1');
    media.onSourceUpdate = (_identity, sources) => {
      if (sources.length === 1) {
        expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBe('participant-1');
      }
    };

    await hosts.revokeShare(activeHost(meeting.id), meeting.slug);

    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBeNull();
    expect(media.sourceUpdates.at(-1)).toEqual({
      identity: 'participant-1', sources: ['microphone']
    });
    expect(audits().at(-1)).toEqual({
      event_type: 'screen_share_revoked', meeting_id: meeting.id,
      subject_id: 'participant-1', metadata_json: '{}'
    });
  });

  it('lets only the matching sharer release after browser or participant disconnect', async () => {
    const { meeting } = await createMeetingWithParticipants('Ada', 'Lin');
    await hosts.grantShare(activeHost(meeting.id), meeting.slug, 'participant-1');
    const release = (hosts as unknown as {
      releaseParticipantShare(slug: string, identity: string): Promise<void>;
    }).releaseParticipantShare;
    expect(release).toBeTypeOf('function');

    await release.call(hosts, meeting.slug, 'participant-2');
    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBe('participant-1');

    await release.call(hosts, meeting.slug, 'participant-1');
    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBeNull();
    expect(media.sourceUpdates.at(-1)).toEqual({ identity: 'participant-1', sources: ['microphone'] });
  });

  it('revokes a kicked participant before LiveKit removal and records the action', async () => {
    const { meeting } = await createMeetingWithParticipants('Ada');
    media.onRemove = (identity) => {
      expect(repository.findParticipantSessionByIdentity(identity, clock.now())).toBeNull();
    };

    await hosts.kickParticipant(activeHost(meeting.id), meeting.slug, 'participant-1');

    expect(media.removed).toEqual(['participant-1']);
    expect(audits()).toEqual([{
      event_type: 'participant_kicked', meeting_id: meeting.id,
      subject_id: 'participant-1', metadata_json: '{}'
    }]);
  });

  it('clears a kicked participant share grant before any screen track is published', async () => {
    const { meeting } = await createMeetingWithParticipants('Ada');
    await hosts.grantShare(activeHost(meeting.id), meeting.slug, 'participant-1');

    await hosts.kickParticipant(activeHost(meeting.id), meeting.slug, 'participant-1');

    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBeNull();
    expect(media.removed).toEqual(['participant-1']);
  });

  it('retains a kicked participant share grant until media removal succeeds on retry', async () => {
    const { meeting } = await createMeetingWithParticipants('Ada');
    await hosts.grantShare(activeHost(meeting.id), meeting.slug, 'participant-1');
    media.removeFailuresRemaining = 1;

    await expect(hosts.kickParticipant(activeHost(meeting.id), meeting.slug, 'participant-1'))
      .rejects.toMatchObject({ code: 'MEDIA_SERVICE_UNAVAILABLE' });

    expect(repository.findParticipantSessionByIdentity('participant-1', clock.now())).toBeNull();
    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBe('participant-1');

    await hosts.kickParticipant(activeHost(meeting.id), meeting.slug, 'participant-1');

    expect(media.removeAttempts).toEqual(['participant-1', 'participant-1']);
    expect(media.removed).toEqual(['participant-1']);
    expect(repository.findBySlug(meeting.slug)?.shareIdentity).toBeNull();
  });

  it('ends the meeting, revokes the host, and audits the terminal action', async () => {
    const { meeting } = await createMeetingWithParticipants('Ada');

    await hosts.endMeeting(activeHost(meeting.id), meeting.slug);

    expect(repository.findBySlug(meeting.slug)).toMatchObject({ status: 'ended' });
    expect(repository.findHostSessionByTokenHash(hashSessionToken('raw-host-token'), clock.now())).toBeNull();
    expect(audits()).toEqual([{
      event_type: 'meeting_ended_by_host', meeting_id: meeting.id,
      subject_id: null, metadata_json: '{}'
    }]);
  });

  async function createMeetingWithParticipants(...names: string[]) {
    const created = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
    for (const name of names) await meetings.joinMeeting(created.meeting.slug, { nickname: name });
    return created;
  }

  function audits(): Array<{
    event_type: string;
    meeting_id: string | null;
    subject_id: string | null;
    metadata_json: string;
  }> {
    return db.prepare(`
      SELECT event_type, meeting_id, subject_id, metadata_json
      FROM audit_events
      ORDER BY occurred_at, rowid
    `).all() as ReturnType<typeof audits>;
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
  reservationTtlMs: 60_000, maxParticipants: 5,
  p2pStunUrls: ['stun:stun.example.test:3478']
};

class LiteralPasswordHasher implements PasswordHasher {
  async hash(value: string): Promise<string> { return `hash:${value}`; }
  async verify(hash: string, value: string): Promise<boolean> { return hash === `hash:${value}`; }
}

class QueueIds implements IdGenerator {
  private uuidCount = 0;
  private participantCount = 0;
  private tokenCount = 0;

  uuid(): string { return this.uuidCount++ === 0 ? 'meeting-id' : `audit-${this.uuidCount}`; }
  slug(): string { return 'unpredictable-meeting-slug-1234'; }
  token(): string { return this.tokenCount++ === 0 ? 'raw-host-token' : `participant-token-${this.tokenCount}`; }
  participantIdentity(): string { return `participant-${++this.participantCount}`; }
}

class HostMediaFake implements MediaService {
  readonly sourceUpdates: Array<{ identity: string; sources: PublishSource[] }> = [];
  readonly removed: string[] = [];
  readonly removeAttempts: string[] = [];
  removeFailuresRemaining = 0;
  updateError?: Error;
  onSourceUpdate?: (identity: string, sources: PublishSource[]) => void;
  onRemove?: (identity: string) => void;

  async listParticipantIdentities(): Promise<Set<string>> { return new Set(); }
  async issueToken(input: { identity: string }): Promise<string> { return `token:${input.identity}`; }
  async updateParticipantSources(_roomName: string, identity: string, sources: PublishSource[]): Promise<void> {
    this.onSourceUpdate?.(identity, sources);
    if (this.updateError) throw this.updateError;
    this.sourceUpdates.push({ identity, sources: [...sources] });
  }
  async removeParticipant(_roomName: string, identity: string): Promise<void> {
    this.onRemove?.(identity);
    this.removeAttempts.push(identity);
    if (this.removeFailuresRemaining > 0) {
      this.removeFailuresRemaining--;
      throw new Error('media unavailable');
    }
    this.removed.push(identity);
  }
  async deleteRoom(): Promise<void> {}
  async ping(): Promise<void> {}
}

function activeHost(meetingId: string): HostSession {
  return {
    id: 'host-session', meetingId, tokenHash: hashSessionToken('raw-host-token'),
    createdAt: 1_000, expiresAt: 10_000, revokedAt: null
  };
}
