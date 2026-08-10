import type { RefreshParticipantTokenResponse } from '@meeting/contracts';

import type { AppConfig } from '../config.js';
import { domainError } from '../domain/errors.js';
import { SessionAuthenticationError } from '../http/auth.js';
import {
  NORMAL_PUBLISH_SOURCES,
  SHARE_PUBLISH_SOURCES,
  type MediaService
} from '../livekit/media-service.js';
import type { MeetingRepository } from '../repositories/meeting-repository.js';
import type { MeetingRecord, ParticipantSession } from '../repositories/models.js';
import { hashSessionToken } from '../security/session-token.js';
import type { Clock } from './meeting-service.js';

export type ActiveParticipantSession = ParticipantSession;

export interface ParticipantsResult {
  participants: Array<{ identity: string; name: string; isSharing: boolean }>;
}

export class ParticipantApplicationService {
  constructor(private readonly dependencies: {
    repository: MeetingRepository;
    media: MediaService;
    clock: Clock;
    config: AppConfig;
  }) {}

  authenticate(rawToken: string, slug: string): ActiveParticipantSession {
    const session = this.dependencies.repository.findParticipantSessionByTokenHash(
      hashSessionToken(rawToken),
      this.dependencies.clock.now()
    );
    if (!session) throw new SessionAuthenticationError();
    this.authorize(session, slug);
    return session;
  }

  authenticateForLeave(rawToken: string, slug: string): ParticipantSession {
    const session = this.dependencies.repository.findParticipantSessionByTokenHashIncludingRevoked(
      hashSessionToken(rawToken),
      this.dependencies.clock.now()
    );
    if (!session) throw new SessionAuthenticationError();
    const meeting = this.dependencies.repository.findBySlug(slug);
    if (!meeting) throw domainError('MEETING_NOT_FOUND');
    if (session.meetingId !== meeting.id) throw new SessionAuthenticationError();
    return session;
  }

  /** Current `meetings.share_identity` for a meeting, used by P2P signaling
   *  forwarding rules. Callers must have authenticated first. */
  getShareIdentity(slug: string): string | null {
    return this.dependencies.repository.findBySlug(slug)?.shareIdentity ?? null;
  }

  async refreshToken(
    session: ActiveParticipantSession,
    slug: string
  ): Promise<RefreshParticipantTokenResponse> {
    const meeting = this.authorize(session, slug);
    const canShareScreen = meeting.shareIdentity === session.identity;
    let token: string;
    try {
      token = await this.dependencies.media.issueToken({
        meetingId: meeting.id,
        identity: session.identity,
        nickname: session.nickname,
        sources: canShareScreen ? [...SHARE_PUBLISH_SOURCES] : [...NORMAL_PUBLISH_SOURCES]
      });
    } catch {
      throw domainError('MEDIA_SERVICE_UNAVAILABLE');
    }
    return {
      participantIdentity: session.identity,
      participantName: session.nickname,
      livekitUrl: this.dependencies.config.livekitUrl.toString(),
      token,
      meetingExpiresAt: meeting.expiresAt,
      permissions: { canPublishMicrophone: true, canShareScreen }
    };
  }

  async listParticipants(
    session: ActiveParticipantSession,
    slug: string
  ): Promise<ParticipantsResult> {
    const meeting = this.authorize(session, slug);
    let connected: Set<string>;
    try {
      connected = await this.dependencies.media.listParticipantIdentities(meeting.id);
    } catch {
      throw domainError('MEDIA_SERVICE_UNAVAILABLE');
    }
    const active = this.dependencies.repository.listActiveParticipantSessions(
      meeting.id,
      this.dependencies.clock.now()
    );
    return {
      participants: active
        .filter((participant) => connected.has(participant.identity))
        .map((participant) => ({
          identity: participant.identity,
          name: participant.nickname,
          isSharing: participant.identity === meeting.shareIdentity
        }))
    };
  }

  private authorize(session: ActiveParticipantSession, slug: string): MeetingRecord {
    const meeting = this.dependencies.repository.findBySlug(slug);
    if (!meeting) throw domainError('MEETING_NOT_FOUND');
    if (meeting.status === 'ended' || meeting.status === 'expired') throw domainError('MEETING_EXPIRED');
    const active = this.dependencies.repository.findParticipantSessionByIdentity(
      session.identity,
      this.dependencies.clock.now()
    );
    if (!active
      || active.tokenHash !== session.tokenHash
      || session.meetingId !== meeting.id
      || active.meetingId !== meeting.id) {
      throw new SessionAuthenticationError();
    }
    return meeting;
  }
}
