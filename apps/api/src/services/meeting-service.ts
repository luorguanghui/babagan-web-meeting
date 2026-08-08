import type { AppConfig } from '../config.js';
import { domainError } from '../domain/errors.js';
import { nextMeetingStatus } from '../domain/time.js';
import type { MeetingRepository } from '../repositories/meeting-repository.js';
import type { MeetingRecord } from '../repositories/models.js';
import { authenticateMeetingPassword, type PasswordHasher } from '../security/password-hasher.js';
import { hashSessionToken } from '../security/session-token.js';
import { KeyedMutex } from './keyed-mutex.js';

export type { PasswordHasher } from '../security/password-hasher.js';

export interface Clock {
  now(): number;
}

export interface IdGenerator {
  uuid(): string;
  slug(): string;
  token(): string;
  participantIdentity(): string;
}

export interface MediaService {
  listParticipantIdentities(meetingId: string): Promise<string[]>;
  issueParticipantToken(input: {
    meetingId: string;
    identity: string;
    nickname: string;
    expiresAt: number;
  }): Promise<string>;
  removeParticipant(meetingId: string, identity: string): Promise<void>;
  closeMeeting(meetingId: string): Promise<void>;
}

export interface CreateMeetingInput {
  name: string;
  meetingPassword?: string;
}

export interface JoinMeetingInput {
  nickname: string;
  meetingPassword?: string;
}

export interface MeetingSummary {
  name: string;
  status: MeetingRecord['status'];
  requiresPassword: boolean;
  isFull: boolean;
}

export interface JoinMeetingResult {
  participantIdentity: string;
  participantName: string;
  livekitUrl: string;
  token: string;
  meetingExpiresAt: number;
  permissions: { publishSources: ['microphone'] };
  participantSessionToken: string;
}

export class MeetingService {
  private readonly mutex: KeyedMutex;

  public constructor(private readonly dependencies: {
    repository: MeetingRepository;
    media: MediaService;
    passwords: PasswordHasher;
    clock: Clock;
    ids: IdGenerator;
    config: AppConfig;
    mutex?: KeyedMutex;
  }) {
    this.mutex = dependencies.mutex ?? new KeyedMutex();
  }

  async createMeeting(
    input: CreateMeetingInput,
    afterCreate?: (meeting: MeetingRecord) => void
  ): Promise<MeetingRecord> {
    if (input.meetingPassword === '') throw new Error('Meeting password must not be empty');
    if (this.dependencies.repository.findNonTerminal()) {
      throw domainError('MEETING_ALREADY_ACTIVE');
    }

    const now = this.dependencies.clock.now();
    const passwordHash = input.meetingPassword === undefined
      ? null
      : await this.dependencies.passwords.hash(input.meetingPassword);

    try {
      return this.dependencies.repository.transaction(() => {
        const meeting = this.dependencies.repository.createMeeting({
          id: this.dependencies.ids.uuid(),
          slug: this.dependencies.ids.slug(),
          name: input.name,
          passwordHash,
          createdAt: now,
          expiresAt: now + this.dependencies.config.meetingTtlMs
        });
        afterCreate?.(meeting);
        return meeting;
      });
    } catch (error) {
      if (isNonTerminalConflict(error)) throw domainError('MEETING_ALREADY_ACTIVE');
      throw error;
    }
  }

  async getMeetingSummary(slug: string): Promise<MeetingSummary> {
    const meeting = this.requireMeeting(slug);
    return this.mutex.runExclusive(meeting.id, async () => {
      const synchronized = await this.synchronize(this.requireMeeting(slug));
      const occupied = await this.occupiedIdentities(synchronized);

      return {
        name: synchronized.name,
        status: synchronized.status,
        requiresPassword: synchronized.passwordHash !== null,
        isFull: !isTerminal(synchronized) && occupied.size >= this.dependencies.config.maxParticipants
      };
    });
  }

  async joinMeeting(slug: string, input: JoinMeetingInput): Promise<JoinMeetingResult> {
    const meeting = this.requireMeeting(slug);
    await this.verifyPassword(meeting, input.meetingPassword);

    return this.mutex.runExclusive(meeting.id, async () => {
      const synchronized = await this.synchronize(this.requireMeeting(slug));
      if (isTerminal(synchronized)) throw domainError('MEETING_EXPIRED');

      const occupied = await this.occupiedIdentities(synchronized);
      const finalized = await this.applyLifecycle(synchronized, occupied.size);
      if (isTerminal(finalized)) throw domainError('MEETING_EXPIRED');
      if (occupied.size >= this.dependencies.config.maxParticipants) throw domainError('MEETING_FULL');

      const now = this.dependencies.clock.now();
      const identity = this.dependencies.ids.participantIdentity();
      const participantSessionToken = this.dependencies.ids.token();
      const token = await this.dependencies.media.issueParticipantToken({
        meetingId: finalized.id,
        identity,
        nickname: input.nickname,
        expiresAt: finalized.expiresAt
      });

      this.dependencies.repository.transaction(() => {
        this.dependencies.repository.insertReservation({
          identity,
          meetingId: finalized.id,
          nickname: input.nickname,
          issuedAt: now,
          expiresAt: now + this.dependencies.config.reservationTtlMs
        });
        this.dependencies.repository.upsertParticipantSession({
          identity,
          meetingId: finalized.id,
          nickname: input.nickname,
          tokenHash: hashSessionToken(participantSessionToken),
          expiresAt: finalized.expiresAt,
          revokedAt: null
        });
        this.dependencies.repository.updateMeetingLifecycle(finalized.id, {
          status: 'active', emptySince: null, endedAt: null
        });
      });

      return {
        participantIdentity: identity,
        participantName: input.nickname,
        livekitUrl: this.dependencies.config.livekitUrl.toString(),
        token,
        meetingExpiresAt: finalized.expiresAt,
        permissions: { publishSources: ['microphone'] },
        participantSessionToken
      };
    });
  }

  async leaveMeeting(slug: string, identity: string): Promise<void> {
    const meeting = this.requireMeeting(slug);
    await this.mutex.runExclusive(meeting.id, async () => {
      const current = this.requireMeeting(slug);
      this.dependencies.repository.transaction(() => {
        this.dependencies.repository.deleteReservation(identity);
        this.dependencies.repository.revokeParticipantSession(identity, this.dependencies.clock.now());
      });
      await this.dependencies.media.removeParticipant(current.id, identity);
      this.dependencies.repository.clearShareIdentityIfMatches(current.id, identity);
      await this.synchronize(current);
    });
  }

  async endMeeting(slug: string): Promise<void> {
    const meeting = this.requireMeeting(slug);
    await this.mutex.runExclusive(meeting.id, async () => {
      const current = this.requireMeeting(slug);
      if (isTerminal(current)) return;

      this.end(current, 'ended');
      await this.closeTerminalMedia(this.requireMeeting(slug));
    });
  }

  async runCleanup(): Promise<string[]> {
    const cleaned: string[] = [];
    const meeting = this.dependencies.repository.findNonTerminal();
    if (meeting) {
      await this.mutex.runExclusive(meeting.id, async () => {
        const current = this.dependencies.repository.findBySlug(meeting.slug);
        if (!current || isTerminal(current)) return;
        const synchronized = await this.synchronize(current);
        if (isTerminal(synchronized)) cleaned.push(synchronized.slug);
      });
    }

    for (const terminal of this.dependencies.repository.findTerminalMeetingsAwaitingMediaCleanup()) {
      await this.mutex.runExclusive(terminal.id, async () => {
        const current = this.dependencies.repository.findBySlug(terminal.slug);
        if (!current || !isTerminal(current) || current.mediaClosedAt !== null) return;
        await this.closeTerminalMedia(current);
        cleaned.push(current.slug);
      });
    }

    return cleaned;
  }

  private requireMeeting(slug: string): MeetingRecord {
    const meeting = this.dependencies.repository.findBySlug(slug);
    if (!meeting) throw domainError('MEETING_NOT_FOUND');
    return meeting;
  }

  private async verifyPassword(meeting: MeetingRecord, password: string | undefined): Promise<void> {
    if (meeting.passwordHash === null) return;
    await authenticateMeetingPassword(this.dependencies.passwords, meeting.passwordHash, password);
  }

  private async synchronize(meeting: MeetingRecord): Promise<MeetingRecord> {
    if (isTerminal(meeting)) return meeting;

    const occupied = await this.occupiedIdentities(meeting);
    return this.applyLifecycle(meeting, occupied.size);
  }

  private async applyLifecycle(meeting: MeetingRecord, participantCount: number): Promise<MeetingRecord> {
    const now = this.dependencies.clock.now();
    const transition = nextMeetingStatus({
      status: meeting.status,
      participantCount,
      now,
      expiresAt: meeting.expiresAt,
      emptySince: meeting.emptySince
    });
    if (transition.status === meeting.status && transition.emptySince === meeting.emptySince) return meeting;

    if (transition.status === 'ended' || transition.status === 'expired') {
      this.end(meeting, transition.status, transition.emptySince);
      await this.closeTerminalMedia(this.requireMeeting(meeting.slug));
      return this.requireMeeting(meeting.slug);
    }

    return this.dependencies.repository.updateMeetingLifecycle(meeting.id, {
      status: transition.status,
      emptySince: transition.emptySince,
      endedAt: null
    });
  }

  private end(meeting: MeetingRecord, status: 'ended' | 'expired', emptySince = meeting.emptySince): void {
    const now = this.dependencies.clock.now();
    this.dependencies.repository.transaction(() => {
      this.dependencies.repository.updateMeetingLifecycle(meeting.id, { status, emptySince, endedAt: now });
      this.dependencies.repository.revokeParticipantSessionsForMeeting(meeting.id, now);
      this.dependencies.repository.revokeHostSessionsForMeeting(meeting.id, now);
    });
  }

  private async closeTerminalMedia(meeting: MeetingRecord): Promise<void> {
    if (meeting.mediaClosedAt !== null) return;
    try {
      await this.dependencies.media.closeMeeting(meeting.id);
    } catch {
      throw domainError('MEDIA_SERVICE_UNAVAILABLE');
    }
    this.dependencies.repository.markMeetingMediaClosed(meeting.id, this.dependencies.clock.now());
  }

  private async occupiedIdentities(meeting: MeetingRecord): Promise<Set<string>> {
    let connected: string[];
    try {
      connected = await this.dependencies.media.listParticipantIdentities(meeting.id);
    } catch {
      throw domainError('MEDIA_SERVICE_UNAVAILABLE');
    }
    const reserved = this.dependencies.repository.listLiveReservations(meeting.id, this.dependencies.clock.now());
    return new Set([...connected, ...reserved.map((reservation) => reservation.identity)]);
  }
}

function isTerminal(meeting: MeetingRecord): boolean {
  return meeting.status === 'ended' || meeting.status === 'expired';
}

function isNonTerminalConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}
