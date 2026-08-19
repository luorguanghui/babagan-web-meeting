import type { MeetingStatus } from '../repositories/models.js';

export const MEETING_TTL_MS = 86_400_000;
export const EMPTY_GRACE_MS = 600_000;
export const RECONNECT_GRACE_MS = 30_000;
export const RESERVATION_TTL_MS = 60_000;

export interface MeetingTransition {
  status: MeetingStatus;
  emptySince: number | null;
}

export function nextMeetingStatus(input: {
  status: MeetingStatus;
  participantCount: number;
  now: number;
  expiresAt: number;
  emptySince: number | null;
}): MeetingTransition {
  if (input.status === 'ended' || input.status === 'expired') {
    return { status: input.status, emptySince: input.emptySince };
  }

  if (input.now >= input.expiresAt) {
    return { status: 'expired', emptySince: input.emptySince };
  }

  if (input.participantCount > 0) {
    return { status: 'active', emptySince: null };
  }

  if (input.status === 'active') {
    return { status: 'grace', emptySince: input.now };
  }

  if (input.status === 'grace') {
    const emptySince = input.emptySince ?? input.now;
    return input.now >= emptySince + EMPTY_GRACE_MS
      ? { status: 'ended', emptySince }
      : { status: 'grace', emptySince };
  }

  return { status: 'created', emptySince: null };
}

export function isWithinReconnectGrace(disconnectedAt: number, now: number): boolean {
  return now < disconnectedAt + RECONNECT_GRACE_MS;
}
