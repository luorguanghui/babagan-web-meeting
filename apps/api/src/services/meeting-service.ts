import type { AppConfig } from '../config.js';
import { domainError } from '../domain/errors.js';
import { nextMeetingStatus } from '../domain/time.js';
import type { MeetingRepository } from '../repositories/meeting-repository.js';
import type { MeetingRecord } from '../repositories/models.js';
import { KeyedMutex } from './keyed-mutex.js';

export interface Clock {
  now(): number;
}

export interface IdGenerator {
  uuid(): string;
  slug(): string;
  token(): string;
  participantIdentity(): string;
}

export interface PasswordHasher {
  hash(value: string): Promise<string>;
  verify(hash: string, value: string): Promise<boolean>;
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

  async createMeeting(input: CreateMeetingInput): Promise<MeetingRecord> {
    if (this.dependencies.repository.findNonTerminal()) {
      throw domainError('MEETING_ALREADY_ACTIVE');
    }

    const now = this.dependencies.clock.now();
    const passwordHash = input.meetingPassword === undefined
      ? null
      : await this.dependencies.passwords.hash(input.meetingPassword);

    try {
      return this.dependencies.repository.createMeeting({
        id: this.dependencies.ids.uuid(),
        slug: this.dependencies.ids.slug(),
        name: input.name,
        passwordHash,
        createdAt: now,
        expiresAt: now + this.dependencies.config.meetingTtlMs
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
      if (occupied.size >= this.dependencies.config.maxParticipants) throw domainError('MEETING_FULL');

      const now = this.dependencies.clock.now();
      const identity = this.dependencies.ids.participantIdentity();
      const token = await this.dependencies.media.issueParticipantToken({
        meetingId: synchronized.id,
        identity,
        nickname: input.nickname,
        expiresAt: synchronized.expiresAt
      });

      this.dependencies.repository.transaction(() => {
        this.dependencies.repository.insertReservation({
          identity,
          meetingId: synchronized.id,
          nickname: input.nickname,
          issuedAt: now,
          expiresAt: now + this.dependencies.config.reservationTtlMs
        });
        this.dependencies.repository.upsertParticipantSession({
          identity,
          meetingId: synchronized.id,
          nickname: input.nickname,
          tokenHash: this.dependencies.ids.token(),
          expiresAt: synchronized.expiresAt,
          revokedAt: null
        });
        this.dependencies.repository.updateMeetingLifecycle(synchronized.id, {
          status: 'active', emptySince: null, endedAt: null
        });
      });

      return {
        participantIdentity: identity,
        participantName: input.nickname,
        livekitUrl: this.dependencies.config.livekitUrl.toString(),
        token,
        meetingExpiresAt: synchronized.expiresAt,
        permissions: { publishSources: ['microphone'] }
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
      await this.synchronize(current);
    });
  }

  async endMeeting(slug: string): Promise<void> {
    const meeting = this.requireMeeting(slug);
    await this.mutex.runExclusive(meeting.id, async () => {
      const current = this.requireMeeting(slug);
      if (isTerminal(current)) return;

      this.end(current, 'ended');
      await this.dependencies.media.closeMeeting(current.id);
    });
  }

  async runCleanup(): Promise<string[]> {
    const meeting = this.dependencies.repository.findNonTerminal();
    if (!meeting) return [];

    return this.mutex.runExclusive(meeting.id, async () => {
      const current = this.dependencies.repository.findBySlug(meeting.slug);
      if (!current || isTerminal(current)) return [];
      const synchronized = await this.synchronize(current);
      return isTerminal(synchronized) ? [synchronized.slug] : [];
    });
  }

  private requireMeeting(slug: string): MeetingRecord {
    const meeting = this.dependencies.repository.findBySlug(slug);
    if (!meeting) throw domainError('MEETING_NOT_FOUND');
    return meeting;
  }

  private async verifyPassword(meeting: MeetingRecord, password: string | undefined): Promise<void> {
    if (meeting.passwordHash === null) return;
    if (password === undefined || !await this.dependencies.passwords.verify(meeting.passwordHash, password)) {
      throw domainError('INVALID_MEETING_PASSWORD');
    }
  }

  private async synchronize(meeting: MeetingRecord): Promise<MeetingRecord> {
    if (isTerminal(meeting)) return meeting;

    const occupied = await this.occupiedIdentities(meeting);
    const now = this.dependencies.clock.now();
    const transition = nextMeetingStatus({
      status: meeting.status,
      participantCount: occupied.size,
      now,
      expiresAt: meeting.expiresAt,
      emptySince: meeting.emptySince
    });
    if (transition.status === meeting.status && transition.emptySince === meeting.emptySince) return meeting;

    if (transition.status === 'ended' || transition.status === 'expired') {
      this.end(meeting, transition.status, transition.emptySince);
      await this.dependencies.media.closeMeeting(meeting.id);
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
    });
  }

  private async occupiedIdentities(meeting: MeetingRecord): Promise<Set<string>> {
    const connected = await this.dependencies.media.listParticipantIdentities(meeting.id);
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
