import type {
  JoinReservation,
  MeetingRecord,
  NewMeetingRecord,
  ParticipantSession,
  ShareUpdateResult
} from './models.js';

export interface MeetingRepository {
  transaction<T>(fn: () => T): T;
  createMeeting(input: NewMeetingRecord): MeetingRecord;
  findBySlug(slug: string): MeetingRecord | null;
  findNonTerminal(): MeetingRecord | null;
  listLiveReservations(meetingId: string, now: number): JoinReservation[];
  insertReservation(value: JoinReservation): void;
  deleteReservation(identity: string): void;
  upsertParticipantSession(value: ParticipantSession): void;
  revokeParticipantSession(identity: string, at: number): void;
  trySetShareIdentity(meetingId: string, version: number, identity: string | null): ShareUpdateResult;
  markWebhookProcessed(eventId: string, at: number): boolean;
}
