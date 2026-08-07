import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import {
  ApiErrorResponseSchema,
  CreateMeetingRequestSchema,
  JoinMeetingRequestSchema,
  JoinMeetingResponseSchema,
  KickParticipantRequestSchema,
  MeetingSummarySchema,
  ParticipantSummarySchema,
  ShareGrantRequestSchema
} from './index.js';

describe('meeting HTTP contracts', () => {
  it('accepts a valid create-meeting request', () => {
    expect(Value.Check(CreateMeetingRequestSchema, {
      name: '周会',
      adminPassword: 'correct horse battery staple'
    })).toBe(true);
  });

  it('rejects empty create-meeting fields and extra properties', () => {
    expect(Value.Check(CreateMeetingRequestSchema, { name: '', adminPassword: '' })).toBe(false);
    expect(Value.Check(CreateMeetingRequestSchema, {
      name: '周会',
      adminPassword: 'correct horse battery staple',
      unexpected: true
    })).toBe(false);
  });

  it('rejects nicknames longer than forty characters', () => {
    expect(Value.Check(JoinMeetingRequestSchema, { nickname: 'A'.repeat(41) })).toBe(false);
  });

  it('accepts only the documented meeting-summary fields', () => {
    expect(Value.Check(MeetingSummarySchema, {
      name: '周会',
      status: 'active',
      requiresPassword: true,
      isFull: false
    })).toBe(true);
    expect(Value.Check(MeetingSummarySchema, {
      name: '周会',
      status: 'unknown',
      requiresPassword: true,
      isFull: false
    })).toBe(false);
  });

  it('accepts a join response without a meeting password', () => {
    expect(Value.Check(JoinMeetingResponseSchema, {
      participantIdentity: 'participant-1',
      participantName: 'Ada',
      livekitUrl: 'wss://rtc.example.test',
      token: 'signed-token',
      meetingExpiresAt: 1_725_000_000_000,
      permissions: { publishSources: ['microphone'] }
    })).toBe(true);
  });

  it('rejects a join response that exposes a non-WSS LiveKit URL', () => {
    expect(Value.Check(JoinMeetingResponseSchema, {
      participantIdentity: 'participant-1',
      participantName: 'Ada',
      livekitUrl: 'ws://rtc.example.test',
      token: 'signed-token',
      meetingExpiresAt: 1_725_000_000_000,
      permissions: { publishSources: ['microphone'] }
    })).toBe(false);
  });

  it('validates participant-management request identities', () => {
    expect(Value.Check(ParticipantSummarySchema, {
      identity: 'participant-1',
      name: 'Ada',
      isSharing: false
    })).toBe(true);
    expect(Value.Check(KickParticipantRequestSchema, { participantIdentity: '' })).toBe(false);
    expect(Value.Check(ShareGrantRequestSchema, { participantIdentity: '' })).toBe(false);
  });

  it('allows only supported public API error codes', () => {
    expect(Value.Check(ApiErrorResponseSchema, {
      error: {
        code: 'MEETING_FULL',
        message: '会议人数已满',
        correlationId: 'request-123'
      }
    })).toBe(true);
    expect(Value.Check(ApiErrorResponseSchema, {
      error: { code: 'INTERNAL_ERROR', message: 'no', correlationId: 'request-123' }
    })).toBe(false);
  });
});
