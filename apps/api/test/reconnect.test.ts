import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { LiveKitWebhookHandler } from '../src/livekit/webhook-handler.js';
import type { IceServer, MediaService, PublishSource } from '../src/livekit/media-service.js';
import { SqliteMeetingRepository } from '../src/repositories/sqlite-meeting-repository.js';
import { hashSessionToken } from '../src/security/session-token.js';
import type { IdGenerator } from '../src/services/meeting-service.js';
import { ParticipantApplicationService } from '../src/services/participant-application-service.js';
import { FakeClock } from './fakes/fake-clock.js';

describe('participant token refresh and reconnect authorization', () => {
  let directory: string;
  let db: Database.Database;
  let repository: SqliteMeetingRepository;
  let clock: FakeClock;
  let media: TokenMedia;
  let participants: ParticipantApplicationService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'meeting-reconnect-'));
    db = createDatabase(join(directory, 'meetings.sqlite'));
    migrate(db);
    repository = new SqliteMeetingRepository(db);
    clock = new FakeClock(1_000);
    media = new TokenMedia();
    repository.createMeeting({ id: 'meeting-1', slug: 'abcdefghijklmnopqrstuv', name: 'Daily', passwordHash: null, createdAt: 1, expiresAt: 10_000 });
    repository.upsertParticipantSession({
      identity: 'participant-1', meetingId: 'meeting-1', nickname: 'Ada',
      tokenHash: hashSessionToken('participant-cookie'), expiresAt: 9_000, revokedAt: null
    });
    participants = new ParticipantApplicationService({ repository, media, clock, ids, config });
  });

  afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

  it('issues a five-minute replacement token from the signed participant session only', async () => {
    const session = participants.authenticate('participant-cookie', 'abcdefghijklmnopqrstuv');

    await expect(participants.refreshToken(session, 'abcdefghijklmnopqrstuv')).resolves.toMatchObject({
      participantIdentity: 'participant-1', participantName: 'Ada',
      permissions: { canPublishMicrophone: true, canShareScreen: false }
    });
    expect(media.issued).toEqual([{ identity: 'participant-1', sources: ['microphone'] }]);
  });

  it('rejects refresh for expired meetings, revoked sessions and a mismatched meeting/session', async () => {
    const session = participants.authenticate('participant-cookie', 'abcdefghijklmnopqrstuv');
    repository.updateMeetingLifecycle('meeting-1', { status: 'expired', emptySince: null, endedAt: 1_000 });
    await expect(participants.refreshToken(session, 'abcdefghijklmnopqrstuv')).rejects.toMatchObject({ code: 'MEETING_EXPIRED' });

    repository.updateMeetingLifecycle('meeting-1', { status: 'active', emptySince: null, endedAt: null });
    repository.revokeParticipantSession('participant-1', clock.now());
    await expect(participants.refreshToken(session, 'abcdefghijklmnopqrstuv')).rejects.toMatchObject({ name: 'SessionAuthenticationError' });
    await expect(participants.refreshToken({ ...session, meetingId: 'another-meeting' }, 'abcdefghijklmnopqrstuv'))
      .rejects.toMatchObject({ name: 'SessionAuthenticationError' });
  });

  it('removes a revoked identity that reconnects to LiveKit with an old JWT', () => {
    repository.revokeParticipantSession('participant-1', clock.now());
    const handler = new LiveKitWebhookHandler({ database: db, media, apiKey: 'key', apiSecret: 'secret', clock });
    const action = (handler as unknown as { participantJoined(event: unknown): unknown }).participantJoined({
      room: { name: 'meeting-1' }, participant: { identity: 'participant-1' }
    });

    expect(action).toEqual({ kind: 'remove', roomName: 'meeting-1', identity: 'participant-1' });
  });
});

const ids: IdGenerator = {
  uuid: () => 'audit-1',
  slug: () => 'unused-slug',
  token: () => 'unused-token',
  participantIdentity: () => 'unused-identity'
};

const config: AppConfig = {
  nodeEnv: 'test', publicBaseUrl: new URL('https://meet.example.test'), livekitUrl: new URL('wss://rtc.example.test'),
  livekitInternalUrl: new URL('ws://livekit.internal'), livekitApiKey: 'key', livekitApiSecret: 'secret',
  adminPasswordHash: 'hash:admin-secret', cookieSecret: 'a'.repeat(32), databasePath: ':memory:',
  meetingTtlMs: 86_400_000, emptyGraceMs: 600_000, reconnectGraceMs: 30_000, reservationTtlMs: 60_000, maxParticipants: 5
};

class TokenMedia implements MediaService {
  readonly issued: Array<{ identity: string; sources: PublishSource[] }> = [];
  async listParticipantIdentities(): Promise<Set<string>> { return new Set(); }
  async issueToken(input: { identity: string; sources?: PublishSource[] }): Promise<string> {
    this.issued.push({ identity: input.identity, sources: [...(input.sources ?? [])] });
    return 'fresh-livekit-token';
  }
  async updateParticipantSources(): Promise<void> {}
  async removeParticipant(): Promise<void> {}
  async deleteRoom(): Promise<void> {}
  async ping(): Promise<void> {}
  async fetchIceServers(): Promise<IceServer[]> { return []; }
}
