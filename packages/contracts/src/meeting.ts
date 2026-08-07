import { Static, Type } from '@sinclair/typebox';

import { ApiErrorCodeSchema } from './errors.js';

export const CreateMeetingRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  adminPassword: Type.String({ minLength: 1, maxLength: 256 }),
  meetingPassword: Type.Optional(Type.String({ minLength: 6, maxLength: 128 }))
}, { additionalProperties: false });

export type CreateMeetingRequest = Static<typeof CreateMeetingRequestSchema>;

export const CreateMeetingResponseSchema = Type.Object({
  slug: Type.String({ minLength: 22, maxLength: 256 }),
  joinUrl: Type.String({ minLength: 1, pattern: '^https?://' })
}, { additionalProperties: false });

export type CreateMeetingResponse = Static<typeof CreateMeetingResponseSchema>;

export const JoinMeetingRequestSchema = Type.Object({
  nickname: Type.String({ minLength: 1, maxLength: 40 }),
  meetingPassword: Type.Optional(Type.String({ maxLength: 128 }))
}, { additionalProperties: false });

export type JoinMeetingRequest = Static<typeof JoinMeetingRequestSchema>;

export const MeetingSummarySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  status: Type.Union([
    Type.Literal('created'),
    Type.Literal('active'),
    Type.Literal('grace'),
    Type.Literal('ended'),
    Type.Literal('expired')
  ]),
  requiresPassword: Type.Boolean(),
  isFull: Type.Boolean()
}, { additionalProperties: false });

export type MeetingSummary = Static<typeof MeetingSummarySchema>;

export const ParticipantSummarySchema = Type.Object({
  identity: Type.String({ minLength: 1, maxLength: 256 }),
  name: Type.String({ minLength: 1, maxLength: 40 }),
  isSharing: Type.Boolean()
}, { additionalProperties: false });

export type ParticipantSummary = Static<typeof ParticipantSummarySchema>;

export const ParticipantsResponseSchema = Type.Object({
  participants: Type.Array(ParticipantSummarySchema, { maxItems: 5 })
}, { additionalProperties: false });

export type ParticipantsResponse = Static<typeof ParticipantsResponseSchema>;

export const JoinMeetingResponseSchema = Type.Object({
  participantIdentity: Type.String({ minLength: 1, maxLength: 256 }),
  participantName: Type.String({ minLength: 1, maxLength: 40 }),
  livekitUrl: Type.String({ minLength: 1, pattern: '^wss://' }),
  token: Type.String({ minLength: 1 }),
  meetingExpiresAt: Type.Integer({ minimum: 0 }),
  permissions: Type.Object({
    publishSources: Type.Array(Type.Union([
      Type.Literal('microphone'),
      Type.Literal('screen_share'),
      Type.Literal('screen_share_audio')
    ]), { minItems: 1, uniqueItems: true })
  }, { additionalProperties: false })
}, { additionalProperties: false });

export type JoinMeetingResponse = Static<typeof JoinMeetingResponseSchema>;

export const RefreshParticipantTokenResponseSchema = Type.Object({
  participantIdentity: Type.String({ minLength: 1, maxLength: 256 }),
  participantName: Type.String({ minLength: 1, maxLength: 40 }),
  livekitUrl: Type.String({ minLength: 1, pattern: '^wss://' }),
  token: Type.String({ minLength: 1 }),
  meetingExpiresAt: Type.Integer({ minimum: 0 }),
  permissions: Type.Object({
    canPublishMicrophone: Type.Literal(true),
    canShareScreen: Type.Boolean()
  }, { additionalProperties: false })
}, { additionalProperties: false });

export type RefreshParticipantTokenResponse = Static<typeof RefreshParticipantTokenResponseSchema>;

export const KickParticipantRequestSchema = Type.Object({
  participantIdentity: Type.String({ minLength: 1, maxLength: 256 })
}, { additionalProperties: false });

export type KickParticipantRequest = Static<typeof KickParticipantRequestSchema>;

export const ShareGrantRequestSchema = Type.Object({
  participantIdentity: Type.String({ minLength: 1, maxLength: 256 })
}, { additionalProperties: false });

export type ShareGrantRequest = Static<typeof ShareGrantRequestSchema>;

export const ApiErrorResponseSchema = Type.Object({
  error: Type.Object({
    code: ApiErrorCodeSchema,
    message: Type.String({ minLength: 1 }),
    correlationId: Type.String({ minLength: 1 })
  }, { additionalProperties: false })
}, { additionalProperties: false });

export type ApiErrorResponse = Static<typeof ApiErrorResponseSchema>;
