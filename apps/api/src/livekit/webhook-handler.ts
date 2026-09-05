import type Database from 'better-sqlite3';
import {
  TrackSource,
  WebhookReceiver,
  type WebhookEvent
} from 'livekit-server-sdk';

import type { MediaService } from './media-service.js';

type PostCommitMediaAction =
  | { kind: 'remove'; roomName: string; identity: string }
  | { kind: 'sources'; roomName: string; identity: string };

export interface WebhookShareGoneNotice {
  slug: string;
  reason: string;
}

export interface WebhookHandleResult {
  shareGone?: WebhookShareGoneNotice;
}

export interface WebhookHandler {
  handle(rawBody: Uint8Array, authorization?: string): Promise<WebhookHandleResult>;
}

interface WebhookApplyResult {
  mediaAction?: PostCommitMediaAction;
  shareGone?: WebhookShareGoneNotice;
}

export class InvalidLiveKitWebhookError extends Error {
  public constructor() {
    super('Invalid LiveKit webhook');
    this.name = 'InvalidLiveKitWebhookError';
  }
}

export class LiveKitWebhookHandler implements WebhookHandler {
  private readonly receiver: WebhookReceiver;

  public constructor(private readonly dependencies: {
    database: Database.Database;
    media: MediaService;
    apiKey: string;
    apiSecret: string;
    clock: { now(): number };
  }) {
    this.receiver = new WebhookReceiver(dependencies.apiKey, dependencies.apiSecret);
  }

  async handle(rawBody: Uint8Array, authorization?: string): Promise<WebhookHandleResult> {
    const event = await this.receive(rawBody, authorization);
    validateEvent(event);

    const applied = this.dependencies.database.transaction(() => {
      const marked = this.dependencies.database.prepare(`
        INSERT INTO processed_webhooks (event_id, processed_at)
        VALUES (?, ?)
        ON CONFLICT(event_id) DO NOTHING
      `).run(event.id, this.dependencies.clock.now());
      if (marked.changes === 0) return undefined;

      return this.applyEvent(event);
    })();

    if (!applied) return {};

    if (applied.mediaAction) {
      try {
        await this.runMediaAction(applied.mediaAction);
      } catch (error) {
        this.dependencies.database.prepare(`
          DELETE FROM processed_webhooks
          WHERE event_id = ?
        `).run(event.id);
        throw error;
      }
    }

    return applied.shareGone ? { shareGone: applied.shareGone } : {};
  }

  private async runMediaAction(action: PostCommitMediaAction): Promise<void> {
    if (action.kind === 'remove') {
      await this.dependencies.media.removeParticipant(action.roomName, action.identity);
      return;
    }
    await this.dependencies.media.updateParticipantSources(
      action.roomName,
      action.identity,
      ['microphone']
    );
  }

  private async receive(rawBody: Uint8Array, authorization?: string): Promise<WebhookEvent> {
    try {
      const body = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
      return await this.receiver.receive(body, authorization);
    } catch {
      throw new InvalidLiveKitWebhookError();
    }
  }

  private applyEvent(event: WebhookEvent): WebhookApplyResult {
    switch (event.event) {
      case 'participant_joined': return { mediaAction: this.participantJoined(event) };
      case 'participant_left':
      case 'participant_connection_aborted':
        return this.participantLeft(event);
      case 'track_unpublished':
        return this.trackUnpublished(event);
      case 'room_finished':
        this.roomFinished(event);
        return {};
      default: return {};
    }
  }

  private participantJoined(event: WebhookEvent): PostCommitMediaAction | undefined {
    const roomName = requireRoomName(event);
    const identity = requireParticipantIdentity(event);
    const now = this.dependencies.clock.now();
    const session = this.dependencies.database.prepare(`
      SELECT meeting_id, expires_at, revoked_at
      FROM participant_sessions
      WHERE identity = ?
    `).get(identity) as {
      meeting_id: string;
      expires_at: number;
      revoked_at: number | null;
    } | undefined;

    this.dependencies.database.prepare(`
      DELETE FROM join_reservations
      WHERE meeting_id = ? AND identity = ?
    `).run(roomName, identity);
    const authorized = session?.meeting_id === roomName
      && session.revoked_at === null
      && session.expires_at > now;
    if (!authorized) return { kind: 'remove', roomName, identity };

    this.dependencies.database.prepare(`
      UPDATE meetings
      SET status = 'active', empty_since = NULL, ended_at = NULL, version = version + 1
      WHERE id = ? AND status IN ('created', 'grace')
    `).run(roomName);
    return undefined;
  }

  private participantLeft(event: WebhookEvent): WebhookApplyResult {
    const roomName = requireRoomName(event);
    const identity = requireParticipantIdentity(event);
    const now = this.dependencies.clock.now();

    this.dependencies.database.prepare(`
      DELETE FROM join_reservations
      WHERE meeting_id = ? AND identity = ?
    `).run(roomName, identity);
    const cleared = this.dependencies.database.prepare(`
      UPDATE meetings
      SET share_identity = NULL, version = version + 1
      WHERE id = ? AND share_identity = ?
    `).run(roomName, identity).changes === 1;

    if ((event.room?.numParticipants ?? 0) === 0) {
      this.dependencies.database.prepare(`
        UPDATE meetings
        SET status = 'grace', empty_since = COALESCE(empty_since, ?), version = version + 1
        WHERE id = ? AND status IN ('created', 'active', 'grace')
      `).run(now, roomName);
      return cleared ? { shareGone: { slug: roomName, reason: 'share released' } } : {};
    }

    this.dependencies.database.prepare(`
      UPDATE meetings
      SET status = 'active', empty_since = NULL, version = version + 1
      WHERE id = ? AND status = 'grace'
    `).run(roomName);

    return cleared ? { shareGone: { slug: roomName, reason: 'share released' } } : {};
  }

  private trackUnpublished(event: WebhookEvent): WebhookApplyResult {
    if (event.track?.source !== TrackSource.SCREEN_SHARE
      && event.track?.source !== TrackSource.SCREEN_SHARE_AUDIO) return {};

    const roomName = requireRoomName(event);
    const identity = requireParticipantIdentity(event);
    const cleared = this.dependencies.database.prepare(`
      UPDATE meetings
      SET share_identity = NULL, version = version + 1
      WHERE id = ? AND share_identity = ?
    `).run(roomName, identity).changes === 1;
    return {
      mediaAction: { kind: 'sources', roomName, identity },
      ...(cleared ? { shareGone: { slug: roomName, reason: 'share released' } } : {})
    };
  }

  private roomFinished(event: WebhookEvent): void {
    const roomName = requireRoomName(event);
    const now = this.dependencies.clock.now();

    this.dependencies.database.prepare(`
      UPDATE meetings
      SET
        status = CASE WHEN status = 'expired' THEN 'expired' ELSE 'ended' END,
        share_identity = NULL,
        ended_at = COALESCE(ended_at, ?),
        media_closed_at = COALESCE(media_closed_at, ?),
        version = version + 1
      WHERE id = ?
    `).run(now, now, roomName);
    this.dependencies.database.prepare(`
      UPDATE participant_sessions
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE meeting_id = ?
    `).run(now, roomName);
    this.dependencies.database.prepare(`
      DELETE FROM join_reservations
      WHERE meeting_id = ?
    `).run(roomName);
  }
}

function validateEvent(event: WebhookEvent): void {
  if (!event.id) throw new InvalidLiveKitWebhookError();
  if (event.event === 'participant_joined'
    || event.event === 'participant_left'
    || event.event === 'participant_connection_aborted'
    || event.event === 'track_unpublished'
    || event.event === 'room_finished') {
    requireRoomName(event);
  }
}

function requireRoomName(event: WebhookEvent): string {
  if (!event.room?.name) throw new InvalidLiveKitWebhookError();
  return event.room.name;
}

function requireParticipantIdentity(event: WebhookEvent): string {
  if (!event.participant?.identity) throw new InvalidLiveKitWebhookError();
  return event.participant.identity;
}
