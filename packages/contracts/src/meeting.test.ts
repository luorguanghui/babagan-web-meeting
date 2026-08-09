import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import {
  ApiErrorResponseSchema,
  AdminEndMeetingRequestSchema,
  CreateMeetingResponseSchema,
  CreateMeetingRequestSchema,
  CurrentMeetingResponseSchema,
  JoinMeetingRequestSchema,
  JoinMeetingResponseSchema,
  RefreshParticipantTokenResponseSchema,
  KickParticipantRequestSchema,
  MeetingSummarySchema,
  ParticipantSummarySchema,
  ParticipantsResponseSchema,
  ScreenShareCodecSchema,
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

  it('accepts a minimal meeting-creation response without passwords', () => {
    expect(Value.Check(CreateMeetingResponseSchema, {
      slug: 'WnJ2wX1m4pL6qR8sT0vY3zA5bC7dE9fG',
      joinUrl: 'https://meet.example.test/m/WnJ2wX1m4pL6qR8sT0vY3zA5bC7dE9fG'
    })).toBe(true);
  });

  it('rejects incomplete or password-bearing meeting-creation responses', () => {
    expect(Value.Check(CreateMeetingResponseSchema, {
      slug: 'WnJ2wX1m4pL6qR8sT0vY3zA5bC7dE9fG'
    })).toBe(false);
    expect(Value.Check(CreateMeetingResponseSchema, {
      slug: 'WnJ2wX1m4pL6qR8sT0vY3zA5bC7dE9fG',
      joinUrl: 'https://meet.example.test/m/WnJ2wX1m4pL6qR8sT0vY3zA5bC7dE9fG',
      meetingPassword: 'not-returned'
    })).toBe(false);
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

  it('accepts only the public current-meeting fields or null', () => {
    const meeting = {
      slug: 'WnJ2wX1m4pL6qR8sT0vY3zA5bC7dE9fG',
      name: '周会',
      status: 'active',
      joinUrl: 'https://meet.example.test/meetings/WnJ2wX1m4pL6qR8sT0vY3zA5bC7dE9fG',
      requiresPassword: true,
      isFull: false
    };

    expect(Value.Check(CurrentMeetingResponseSchema, { meeting })).toBe(true);
    expect(Value.Check(CurrentMeetingResponseSchema, { meeting: null })).toBe(true);
    expect(Value.Check(CurrentMeetingResponseSchema, {
      meeting: { ...meeting, passwordHash: 'must-not-leak' }
    })).toBe(false);
    expect(Value.Check(CurrentMeetingResponseSchema, {
      meeting: { ...meeting, status: 'ended' }
    })).toBe(false);
  });

  it('accepts bounded admin-end passwords and only supported screen codecs', () => {
    expect(Value.Check(AdminEndMeetingRequestSchema, { adminPassword: 'secret' })).toBe(true);
    expect(Value.Check(AdminEndMeetingRequestSchema, { adminPassword: '' })).toBe(false);
    expect(Value.Check(AdminEndMeetingRequestSchema, {
      adminPassword: 'secret', unexpected: true
    })).toBe(false);
    expect(['auto', 'h264', 'vp8'].every((codec) => Value.Check(ScreenShareCodecSchema, codec))).toBe(true);
    expect(Value.Check(ScreenShareCodecSchema, 'vp9')).toBe(false);
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

  it('accepts only the documented refresh-token response fields', () => {
    expect(Value.Check(RefreshParticipantTokenResponseSchema, {
      participantIdentity: 'participant-1',
      participantName: 'Ada',
      livekitUrl: 'wss://rtc.example.test',
      token: 'refreshed-token',
      meetingExpiresAt: 1_725_000_000_000,
      permissions: { canPublishMicrophone: true, canShareScreen: false }
    })).toBe(true);
    expect(Value.Check(RefreshParticipantTokenResponseSchema, {
      participantIdentity: 'participant-1',
      participantName: 'Ada',
      livekitUrl: 'wss://rtc.example.test',
      token: 'refreshed-token',
      meetingExpiresAt: 1_725_000_000_000,
      permissions: { canPublishMicrophone: true, canShareScreen: false },
      participantSessionToken: 'must-never-serialize'
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

  it('accepts a minimal participant-list response with share state', () => {
    expect(Value.Check(ParticipantsResponseSchema, {
      participants: [{ identity: 'participant-1', name: 'Ada', isSharing: true }]
    })).toBe(true);
  });

  it('rejects incomplete or password-bearing participant-list responses', () => {
    expect(Value.Check(ParticipantsResponseSchema, {
      participants: [{ identity: 'participant-1', name: 'Ada' }]
    })).toBe(false);
    expect(Value.Check(ParticipantsResponseSchema, {
      participants: [],
      meetingPassword: 'not-returned'
    })).toBe(false);
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
