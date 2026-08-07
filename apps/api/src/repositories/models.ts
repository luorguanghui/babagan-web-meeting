export type MeetingStatus = 'created' | 'active' | 'grace' | 'ended' | 'expired';

export interface MeetingRecord {
  id: string;
  slug: string;
  name: string;
  passwordHash: string | null;
  status: MeetingStatus;
  shareIdentity: string | null;
  createdAt: number;
  expiresAt: number;
  emptySince: number | null;
  endedAt: number | null;
  version: number;
}

export interface NewMeetingRecord {
  id: string;
  slug: string;
  name: string;
  passwordHash: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface HostSession {
  id: string;
  meetingId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

export interface ParticipantSession {
  identity: string;
  meetingId: string;
  nickname: string;
  tokenHash: string;
  expiresAt: number;
  revokedAt: number | null;
}

export interface JoinReservation {
  identity: string;
  meetingId: string;
  nickname: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  meetingId: string | null;
  subjectId: string | null;
  occurredAt: number;
  metadataJson: string;
}

export type ShareUpdateResult =
  | { ok: true }
  | { ok: false; reason: 'VERSION_CONFLICT' };
