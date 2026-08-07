import type {
  AuditEvent,
  JoinReservation,
  HostSession,
  MeetingRecord,
  NewMeetingRecord,
  ParticipantSession,
  ShareUpdateResult
} from './models.js';

export interface MeetingRepository {
  checkReadWrite(): void;
  transaction<T>(fn: () => T): T;
  createMeeting(input: NewMeetingRecord): MeetingRecord;
  findBySlug(slug: string): MeetingRecord | null;
  findNonTerminal(): MeetingRecord | null;
  findTerminalMeetingsAwaitingMediaCleanup(): MeetingRecord[];
  updateMeetingLifecycle(meetingId: string, input: {
    status: MeetingRecord['status'];
    emptySince: number | null;
    endedAt: number | null;
  }): MeetingRecord;
  markMeetingMediaClosed(meetingId: string, at: number): void;
  listLiveReservations(meetingId: string, now: number): JoinReservation[];
  insertReservation(value: JoinReservation): void;
  deleteReservation(identity: string): void;
  createHostSession(value: HostSession): void;
  findHostSessionByTokenHash(tokenHash: string, now: number): HostSession | null;
  revokeHostSessionsForMeeting(meetingId: string, at: number): void;
  upsertParticipantSession(value: ParticipantSession): void;
  findParticipantSessionByTokenHash(tokenHash: string, now: number): ParticipantSession | null;
  findParticipantSessionByIdentity(identity: string, now: number): ParticipantSession | null;
  listActiveParticipantSessions(meetingId: string, now: number): ParticipantSession[];
  insertAuditEvent(value: AuditEvent): void;
  revokeParticipantSession(identity: string, at: number): void;
  revokeParticipantSessionsForMeeting(meetingId: string, at: number): void;
  trySetShareIdentity(meetingId: string, version: number, identity: string | null): ShareUpdateResult;
  markWebhookProcessed(eventId: string, at: number): boolean;
}
