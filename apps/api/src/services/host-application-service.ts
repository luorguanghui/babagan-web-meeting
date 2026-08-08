import type { AppConfig } from '../config.js';
import { domainError } from '../domain/errors.js';
import { SessionAuthenticationError } from '../http/auth.js';
import {
  NORMAL_PUBLISH_SOURCES,
  SHARE_PUBLISH_SOURCES,
  type MediaService
} from '../livekit/media-service.js';
import type { MeetingRepository } from '../repositories/meeting-repository.js';
import type { HostSession, MeetingRecord } from '../repositories/models.js';
import type { PasswordHasher } from '../security/password-hasher.js';
import { hashSessionToken } from '../security/session-token.js';
import { KeyedMutex } from './keyed-mutex.js';
import type { Clock, IdGenerator } from './meeting-service.js';
import { MeetingService } from './meeting-service.js';

export type ActiveHostSession = HostSession;

export class HostApplicationService {
  private readonly mutex: KeyedMutex;

  constructor(private readonly dependencies: {
    repository: MeetingRepository;
    meetings: MeetingService;
    media: MediaService;
    passwords: PasswordHasher;
    clock: Clock;
    ids: IdGenerator;
    config: AppConfig;
    mutex?: KeyedMutex;
  }) {
    this.mutex = dependencies.mutex ?? new KeyedMutex();
  }

  async createMeeting(input: {
    adminPassword: string;
    name: string;
    meetingPassword?: string;
  }): Promise<{ meeting: MeetingRecord; rawHostToken: string }> {
    const valid = await this.dependencies.passwords.verify(
      this.dependencies.config.adminPasswordHash,
      input.adminPassword
    );
    if (!valid) throw domainError('ADMIN_AUTH_FAILED');

    const now = this.dependencies.clock.now();
    const rawHostToken = this.dependencies.ids.token();
    const meeting = await this.dependencies.meetings.createMeeting({
      name: input.name,
      meetingPassword: input.meetingPassword
    }, (created) => {
      this.dependencies.repository.createHostSession({
        id: this.dependencies.ids.uuid(),
        meetingId: created.id,
        tokenHash: hashSessionToken(rawHostToken),
        createdAt: now,
        expiresAt: created.expiresAt,
        revokedAt: null
      });
    });
    return { meeting, rawHostToken };
  }

  authenticate(rawToken: string, slug: string): ActiveHostSession {
    const host = this.dependencies.repository.findHostSessionByTokenHash(
      hashSessionToken(rawToken),
      this.dependencies.clock.now()
    );
    if (!host) throw new SessionAuthenticationError();
    this.authorize(host, slug);
    return host;
  }

  checkDatabase(): void {
    this.dependencies.repository.checkReadWrite();
  }

  async endMeeting(host: ActiveHostSession, slug: string): Promise<void> {
    const meeting = this.authorize(host, slug);
    await this.dependencies.meetings.endMeeting(slug);
    const now = this.dependencies.clock.now();
    this.dependencies.repository.transaction(() => {
      this.dependencies.repository.revokeHostSessionsForMeeting(meeting.id, now);
      this.insertAudit('meeting_ended_by_host', meeting.id, null, '{}', now);
    });
  }

  async kickParticipant(host: ActiveHostSession, slug: string, identity: string): Promise<void> {
    const meeting = this.authorize(host, slug);
    await this.mutex.runExclusive(meeting.id, async () => {
      const activeParticipant = this.dependencies.repository.findParticipantSessionByIdentity(
        identity,
        this.dependencies.clock.now()
      );
      const participant = activeParticipant
        ?? this.dependencies.repository.findParticipantSessionByIdentityIncludingRevoked(identity);
      const now = this.dependencies.clock.now();
      this.dependencies.repository.transaction(() => {
        if (activeParticipant?.meetingId === meeting.id) {
          this.dependencies.repository.revokeParticipantSession(identity, now);
        }
        this.dependencies.repository.insertAuditEvent({
          id: this.dependencies.ids.uuid(),
          eventType: 'participant_kicked',
          meetingId: meeting.id,
          subjectId: identity,
          occurredAt: now,
          metadataJson: '{}'
        });
      });
      if (!participant || participant.meetingId !== meeting.id) return;
      try {
        await this.dependencies.media.removeParticipant(meeting.id, identity);
      } catch {
        throw domainError('MEDIA_SERVICE_UNAVAILABLE');
      }
      this.dependencies.repository.clearShareIdentityIfMatches(meeting.id, identity);
    });
  }

  async grantShare(host: ActiveHostSession, slug: string, identity: string): Promise<void> {
    const meeting = this.authorize(host, slug);
    await this.mutex.runExclusive(meeting.id, async () => {
      const current = this.requireUsableMeeting(slug);
      const participant = this.dependencies.repository.findParticipantSessionByIdentity(
        identity,
        this.dependencies.clock.now()
      );
      if (!participant || participant.meetingId !== current.id) {
        throw domainError('SHARE_NOT_AUTHORIZED');
      }
      if (current.shareIdentity !== null) {
        if (current.shareIdentity === identity) return;
        throw domainError('SHARE_ALREADY_ACTIVE');
      }
      const acquired = this.dependencies.repository.trySetShareIdentity(current.id, current.version, identity);
      if (!acquired.ok) throw domainError('SHARE_ALREADY_ACTIVE');

      try {
        await this.dependencies.media.updateParticipantSources(
          current.id,
          identity,
          [...SHARE_PUBLISH_SOURCES]
        );
      } catch {
        this.dependencies.repository.transaction(() => {
          this.clearMatchingShare(current.slug, identity);
          this.insertAudit(
            'system_error',
            current.id,
            identity,
            '{"operation":"screen_share_grant"}'
          );
        });
        throw domainError('MEDIA_SERVICE_UNAVAILABLE');
      }
      this.insertAudit('screen_share_granted', current.id, identity);
    });
  }

  async revokeShare(host: ActiveHostSession, slug: string): Promise<void> {
    const meeting = this.authorize(host, slug);
    await this.mutex.runExclusive(meeting.id, async () => {
      const current = this.requireUsableMeeting(slug);
      if (current.shareIdentity === null) return;
      try {
        await this.dependencies.media.updateParticipantSources(
          current.id,
          current.shareIdentity,
          [...NORMAL_PUBLISH_SOURCES]
        );
      } catch {
        throw domainError('MEDIA_SERVICE_UNAVAILABLE');
      }
      this.dependencies.repository.transaction(() => {
        this.clearMatchingShare(current.slug, current.shareIdentity!);
        this.insertAudit('screen_share_revoked', current.id, current.shareIdentity);
      });
    });
  }

  async releaseParticipantShare(slug: string, identity: string): Promise<void> {
    const meeting = this.requireUsableMeeting(slug);
    await this.mutex.runExclusive(meeting.id, async () => {
      const current = this.requireUsableMeeting(slug);
      if (current.shareIdentity !== identity) return;
      try {
        await this.dependencies.media.updateParticipantSources(
          current.id,
          identity,
          [...NORMAL_PUBLISH_SOURCES]
        );
      } catch {
        throw domainError('MEDIA_SERVICE_UNAVAILABLE');
      }
      this.dependencies.repository.transaction(() => {
        this.clearMatchingShare(current.slug, identity);
        this.insertAudit('screen_share_released', current.id, identity);
      });
    });
  }

  private authorize(host: ActiveHostSession, slug: string): MeetingRecord {
    const meeting = this.requireUsableMeeting(slug);
    const now = this.dependencies.clock.now();
    if (host.meetingId !== meeting.id || host.revokedAt !== null || host.expiresAt <= now) {
      throw new SessionAuthenticationError();
    }
    return meeting;
  }

  private requireUsableMeeting(slug: string): MeetingRecord {
    const meeting = this.dependencies.repository.findBySlug(slug);
    if (!meeting) throw domainError('MEETING_NOT_FOUND');
    if (meeting.status === 'ended' || meeting.status === 'expired') throw domainError('MEETING_EXPIRED');
    return meeting;
  }

  private clearMatchingShare(slug: string, identity: string): void {
    const current = this.dependencies.repository.findBySlug(slug);
    if (!current || current.shareIdentity !== identity) return;
    this.dependencies.repository.clearShareIdentityIfMatches(current.id, identity);
  }

  private insertAudit(
    eventType: string,
    meetingId: string,
    subjectId: string | null,
    metadataJson = '{}',
    occurredAt = this.dependencies.clock.now()
  ): void {
    this.dependencies.repository.insertAuditEvent({
      id: this.dependencies.ids.uuid(),
      eventType,
      meetingId,
      subjectId,
      occurredAt,
      metadataJson
    });
  }
}
