import { Static, Type } from '@sinclair/typebox';

export const ApiErrorCodeSchema = Type.Union([
  Type.Literal('MEETING_NOT_FOUND'),
  Type.Literal('MEETING_EXPIRED'),
  Type.Literal('MEETING_FULL'),
  Type.Literal('INVALID_MEETING_PASSWORD'),
  Type.Literal('ADMIN_AUTH_FAILED'),
  Type.Literal('SHARE_ALREADY_ACTIVE'),
  Type.Literal('SHARE_NOT_AUTHORIZED'),
  Type.Literal('UNSUPPORTED_CLIENT'),
  Type.Literal('RATE_LIMITED'),
  Type.Literal('MEDIA_SERVICE_UNAVAILABLE')
]);

export type ApiErrorCode = Static<typeof ApiErrorCodeSchema>;
