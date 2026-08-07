import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';
import { ServerError, TrackSource } from 'livekit-server-sdk';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import {
  LiveKitMediaService,
  toLiveKitServerApiUrl
} from '../src/livekit/livekit-media-service.js';
import { TokenService } from '../src/livekit/token-service.js';
import { LiveKitWebhookHandler } from '../src/livekit/webhook-handler.js';
import { SqliteMeetingRepository } from '../src/repositories/sqlite-meeting-repository.js';
import { FakeMediaService } from './fakes/fake-media-service.js';

const apiKey = 'test-api-key';
const apiSecret = 'test-api-secret-with-enough-entropy';

describe('LiveKit token service', () => {
  it('binds a normal participant to one room for exactly five minutes with microphone-only publishing', async () => {
    const service = new TokenService(apiKey, apiSecret);

    const token = await service.issueToken({
      meetingId: 'meeting-1',
      identity: 'participant-1',
      nickname: 'Ada'
    });
    const decoded = decodeJwt(token);

    await expect(new TokenVerifier(apiKey, apiSecret).verify(token)).resolves.toBeDefined();

    expect(decoded.sub).toBe('participant-1');
    expect(decoded.name).toBe('Ada');
    expect(decoded.video).toMatchObject({
      room: 'meeting-1',
      roomJoin: true,
      canSubscribe: true,
      canPublish: true,
      canPublishData: false,
      canPublishSources: ['microphone']
    });
    expect(decoded.video).not.toHaveProperty('roomAdmin');
    expect(decoded.video).not.toHaveProperty('roomCreate');
    expect(decoded.exp - decoded.nbf).toBe(300);
  });

  it('grants an authorized sharer only microphone and both screen sources', async () => {
    const service = new TokenService(apiKey, apiSecret);

    const token = await service.issueToken({
      meetingId: 'meeting-1',
      identity: 'participant-1',
      nickname: 'Ada',
      sources: ['microphone', 'screen_share', 'screen_share_audio']
    });
    const decoded = decodeJwt(token);

    expect(decoded.video.canPublishSources).toEqual([
      'microphone',
      'screen_share',
      'screen_share_audio'
    ]);
    expect(decoded.video.canPublishData).toBe(false);
  });
});

describe('LiveKit media adapter', () => {
  it('maps configured WebSocket endpoints to the HTTP protocol used by the Server API', () => {
    expect(toLiveKitServerApiUrl(new URL('ws://livekit.internal:7880')))
      .toBe('http://livekit.internal:7880/');
    expect(toLiveKitServerApiUrl(new URL('wss://livekit.example.test')))
      .toBe('https://livekit.example.test/');
  });

  it('maps participant listing and source updates to the room administration API', async () => {
    const rooms = new FakeRoomService();
    rooms.participants = [{ identity: 'p1' }, { identity: 'p2' }, { identity: 'p1' }];
    const media = createMedia(rooms);

    await expect(media.listParticipantIdentities('meeting-1'))
      .resolves.toEqual(new Set(['p1', 'p2']));
    await media.updateParticipantSources('meeting-1', 'p1', [
      'microphone', 'screen_share', 'screen_share_audio'
    ]);

    expect(rooms.updated).toEqual([{
      roomName: 'meeting-1',
      identity: 'p1',
      permission: {
        canSubscribe: true,
        canPublish: true,
        canPublishData: false,
        canPublishSources: [
          TrackSource.MICROPHONE,
          TrackSource.SCREEN_SHARE,
          TrackSource.SCREEN_SHARE_AUDIO
        ]
      }
    }]);
  });

  it('removes participants, deletes rooms, and probes readiness through the SDK client', async () => {
    const rooms = new FakeRoomService();
    const media = createMedia(rooms);

    await media.removeParticipant('meeting-1', 'p1');
    await media.deleteRoom('meeting-1');
    await media.ping();

    expect(rooms.removed).toEqual([{ roomName: 'meeting-1', identity: 'p1' }]);
    expect(rooms.deleted).toEqual(['meeting-1']);
    expect(rooms.listRoomsCalls).toBe(1);
  });

  it('treats a previously deleted or nonexistent room as successful cleanup', async () => {
    const rooms = new FakeRoomService();
    rooms.deleteError = new ServerError('Not Found', 'room not found', 404, 'not_found');
    const media = createMedia(rooms);

    await expect(media.deleteRoom('meeting-1')).resolves.toBeUndefined();
    expect(rooms.deleted).toEqual(['meeting-1']);
  });

  it('treats a disconnected or nonexistent participant as successful removal', async () => {
    const rooms = new FakeRoomService();
    rooms.removeError = new ServerError('Not Found', 'participant not found', 404, 'not_found');
    const media = createMedia(rooms);

    await expect(media.removeParticipant('meeting-1', 'gone-participant')).resolves.toBeUndefined();
    expect(rooms.removed).toEqual([{ roomName: 'meeting-1', identity: 'gone-participant' }]);
  });

  it.each([
    new ServerError('Not Found', 'room not found', 404, 'not_found'),
    new ServerError('Unavailable', 'room service unavailable', 503, 'unavailable'),
    new Error('transport reset')
  ])('propagates non-participant removal failure: %s', async (error) => {
    const rooms = new FakeRoomService();
    rooms.removeError = error;
    const media = createMedia(rooms);

    await expect(media.removeParticipant('meeting-1', 'participant-1')).rejects.toBe(error);
  });

  it('preserves genuine participant-removal failures', async () => {
    const rooms = new FakeRoomService();
    rooms.removeError = new Error('LiveKit unavailable');
    const media = createMedia(rooms);

    await expect(media.removeParticipant('meeting-1', 'participant-1'))
      .rejects.toThrow('LiveKit unavailable');
  });
});

describe('LiveKit webhook handler', () => {
  let db: Database.Database;
  let repo: SqliteMeetingRepository;
  let media: FakeMediaService;
  let handler: LiveKitWebhookHandler;

  beforeEach(() => {
    db = createDatabase(':memory:');
    migrate(db);
    repo = new SqliteMeetingRepository(db);
    media = new FakeMediaService();
    handler = new LiveKitWebhookHandler({
      database: db,
      media,
      apiKey,
      apiSecret,
      clock: { now: () => 1_500 }
    });
    createMeeting(repo);
  });

  afterEach(() => db.close());

  it('rejects a bad signature without recording or mutating the event', async () => {
    repo.insertReservation(reservation('participant-1'));
    const delivery = await signedWebhook({
      id: 'event-bad-signature',
      event: 'participant_joined',
      room: { name: 'meeting-1' },
      participant: { identity: 'participant-1' }
    });
    const changedRawBody = Buffer.from(
      delivery.rawBody.toString('utf8').replace('participant-1', 'participant-2')
    );

    await expect(handler.handle(changedRawBody, delivery.authorization)).rejects.toThrow();

    expect(repo.listLiveReservations('meeting-1', 1_500)).toHaveLength(1);
    expect(processedEvents(db)).toEqual([]);
  });

  it('records an event ID once and does not repeat its mutation for a duplicate delivery', async () => {
    repo.insertReservation(reservation('participant-1'));
    insertParticipantSession(db, { identity: 'participant-1' });
    const delivery = await signedWebhook({
      id: 'event-duplicate',
      event: 'participant_joined',
      room: { name: 'meeting-1' },
      participant: { identity: 'participant-1' }
    });

    await handler.handle(delivery.rawBody, delivery.authorization);
    repo.insertReservation(reservation('participant-1'));
    await handler.handle(delivery.rawBody, delivery.authorization);

    expect(repo.listLiveReservations('meeting-1', 1_500)).toHaveLength(1);
    expect(processedEvents(db)).toEqual(['event-duplicate']);
  });

  it('removes a participant join reservation in the event transaction', async () => {
    repo.insertReservation(reservation('participant-1'));
    insertParticipantSession(db, { identity: 'participant-1' });
    const delivery = await signedWebhook({
      id: 'event-joined',
      event: 'participant_joined',
      room: { name: 'meeting-1' },
      participant: { identity: 'participant-1' }
    });

    await handler.handle(delivery.rawBody, delivery.authorization);

    expect(repo.listLiveReservations('meeting-1', 1_500)).toEqual([]);
    expect(processedEvents(db)).toEqual(['event-joined']);
  });

  it('immediately removes a revoked participant that rejoins with an old token', async () => {
    insertParticipantSession(db, { identity: 'participant-1', revokedAt: 1_400 });
    const delivery = await signedWebhook({
      id: 'event-revoked-rejoin',
      event: 'participant_joined',
      room: { name: 'meeting-1' },
      participant: { identity: 'participant-1' }
    });

    await handler.handle(delivery.rawBody, delivery.authorization);

    await handler.handle(delivery.rawBody, delivery.authorization);

    expect(media.removedParticipants).toEqual([{
      roomName: 'meeting-1', identity: 'participant-1'
    }]);
  });

  it('allows a revoked-participant removal to retry when the media call fails', async () => {
    insertParticipantSession(db, { identity: 'participant-1', revokedAt: 1_400 });
    media.removeError = new Error('LiveKit unavailable');
    const delivery = await signedWebhook({
      id: 'event-revoked-retry',
      event: 'participant_joined',
      room: { name: 'meeting-1' },
      participant: { identity: 'participant-1' }
    });

    await expect(handler.handle(delivery.rawBody, delivery.authorization))
      .rejects.toThrow('LiveKit unavailable');
    expect(processedEvents(db)).toEqual([]);

    media.removeError = undefined;
    await handler.handle(delivery.rawBody, delivery.authorization);
    expect(media.removedParticipants).toEqual([{
      roomName: 'meeting-1', identity: 'participant-1'
    }]);
  });

  it('puts a meeting into grace when its final participant leaves', async () => {
    repo.updateMeetingLifecycle('meeting-1', { status: 'active', emptySince: null, endedAt: null });
    const delivery = await signedWebhook({
      id: 'event-left',
      event: 'participant_left',
      room: { name: 'meeting-1', numParticipants: 0 },
      participant: { identity: 'participant-1' }
    });

    await handler.handle(delivery.rawBody, delivery.authorization);

    expect(repo.findBySlug('meeting-one')).toMatchObject({
      status: 'grace', emptySince: 1_500
    });
  });

  it('releases the matching share lock when a screen track is unpublished', async () => {
    const meeting = repo.findBySlug('meeting-one');
    if (!meeting) throw new Error('meeting fixture missing');
    repo.trySetShareIdentity(meeting.id, meeting.version, 'participant-1');
    const delivery = await signedWebhook({
      id: 'event-track-unpublished',
      event: 'track_unpublished',
      room: { name: 'meeting-1' },
      participant: { identity: 'participant-1' },
      track: { source: 'SCREEN_SHARE' }
    });

    await handler.handle(delivery.rawBody, delivery.authorization);
    await handler.handle(delivery.rawBody, delivery.authorization);

    expect(repo.findBySlug('meeting-one')?.shareIdentity).toBeNull();
    expect(media.sourceUpdates).toEqual([{
      roomName: 'meeting-1',
      identity: 'participant-1',
      sources: ['microphone']
    }]);
  });

  it('makes room-finished terminal cleanup complete and revokes every participant session', async () => {
    repo.updateMeetingLifecycle('meeting-1', { status: 'active', emptySince: null, endedAt: null });
    const active = repo.findBySlug('meeting-one');
    if (!active) throw new Error('meeting fixture missing');
    repo.trySetShareIdentity(active.id, active.version, 'participant-1');
    insertParticipantSession(db, { identity: 'participant-1' });
    repo.insertReservation(reservation('participant-1'));
    const delivery = await signedWebhook({
      id: 'event-room-finished',
      event: 'room_finished',
      room: { name: 'meeting-1' }
    });

    await handler.handle(delivery.rawBody, delivery.authorization);

    expect(repo.findBySlug('meeting-one')).toMatchObject({
      status: 'ended',
      shareIdentity: null,
      endedAt: 1_500,
      mediaClosedAt: 1_500
    });
    expect(db.prepare('SELECT revoked_at FROM participant_sessions').all())
      .toEqual([{ revoked_at: 1_500 }]);
    expect(repo.listLiveReservations('meeting-1', 1_500)).toEqual([]);
  });
});

interface DecodedJwt {
  sub: string;
  name: string;
  nbf: number;
  exp: number;
  video: Record<string, unknown> & { canPublishSources: string[]; canPublishData: boolean };
}

function decodeJwt(token: string): DecodedJwt {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('JWT payload is missing');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DecodedJwt;
}

function createMedia(rooms: FakeRoomService): LiveKitMediaService {
  return new LiveKitMediaService({
    internalUrl: 'http://livekit.internal:7880',
    apiKey,
    apiSecret,
    roomService: rooms
  });
}

class FakeRoomService {
  participants: Array<{ identity: string }> = [];
  readonly updated: Array<{
    roomName: string;
    identity: string;
    permission: Record<string, unknown>;
  }> = [];
  readonly removed: Array<{ roomName: string; identity: string }> = [];
  readonly deleted: string[] = [];
  listRoomsCalls = 0;
  deleteError?: Error;
  removeError?: Error;

  async listParticipants(): Promise<Array<{ identity: string }>> {
    return this.participants;
  }

  async updateParticipant(
    roomName: string,
    identity: string,
    options: { permission?: Record<string, unknown> }
  ): Promise<Record<string, never>> {
    this.updated.push({ roomName, identity, permission: options.permission ?? {} });
    return {};
  }

  async removeParticipant(roomName: string, identity: string): Promise<void> {
    this.removed.push({ roomName, identity });
    if (this.removeError) throw this.removeError;
  }

  async deleteRoom(roomName: string): Promise<void> {
    this.deleted.push(roomName);
    if (this.deleteError) throw this.deleteError;
  }

  async listRooms(): Promise<never[]> {
    this.listRoomsCalls++;
    return [];
  }
}

interface WebhookFixture {
  id: string;
  event: string;
  room?: Record<string, unknown>;
  participant?: Record<string, unknown>;
  track?: Record<string, unknown>;
}

function webhookBody(event: WebhookFixture): Buffer {
  return Buffer.from(JSON.stringify({ createdAt: '1', ...event }));
}

async function signedWebhook(event: WebhookFixture): Promise<{
  rawBody: Buffer;
  authorization: string;
}> {
  const rawBody = webhookBody(event);
  const signer = new AccessToken(apiKey, apiSecret);
  signer.sha256 = createHash('sha256').update(rawBody).digest('base64');
  return { rawBody, authorization: await signer.toJwt() };
}

function createMeeting(repo: SqliteMeetingRepository): void {
  repo.createMeeting({
    id: 'meeting-1',
    slug: 'meeting-one',
    name: 'Weekly meeting',
    passwordHash: null,
    createdAt: 1_000,
    expiresAt: 10_000
  });
}

function reservation(identity: string) {
  return {
    identity,
    meetingId: 'meeting-1',
    nickname: 'Ada',
    issuedAt: 1_000,
    expiresAt: 2_000
  };
}

function insertParticipantSession(
  db: Database.Database,
  input: { identity: string; revokedAt?: number | null }
): void {
  db.prepare(`
    INSERT INTO participant_sessions (
      identity, meeting_id, nickname, token_hash, expires_at, revoked_at
    ) VALUES (?, 'meeting-1', 'Ada', 'token-hash', 10_000, ?)
  `).run(input.identity, input.revokedAt ?? null);
}

function processedEvents(db: Database.Database): string[] {
  return (db.prepare('SELECT event_id FROM processed_webhooks ORDER BY event_id').all() as Array<{
    event_id: string;
  }>).map((row) => row.event_id);
}
