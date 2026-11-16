import { Type, type Static } from '@sinclair/typebox';

const ShareId = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' });
const Namespace = Type.String({ minLength: 1, maxLength: 128 });

export const ScreenMoqPublicationSchema = Type.Object({
  shareId: ShareId,
  sharerIdentity: Type.String({ minLength: 1 }),
  sharerName: Type.String({ minLength: 1 }),
  namespace: Namespace
}, { additionalProperties: false });

export const ScreenMoqStatusResponseSchema = Type.Object({
  available: Type.Boolean(),
  publication: Type.Union([ScreenMoqPublicationSchema, Type.Null()])
}, { additionalProperties: false });

export const ScreenMoqConnectionResponseSchema = Type.Object({
  shareId: ShareId,
  namespace: Namespace,
  url: Type.String({ minLength: 1, maxLength: 4096 })
}, { additionalProperties: false });

export const ScreenMoqSubscribeRequestSchema = Type.Object({
  shareId: ShareId
}, { additionalProperties: false });

export type ScreenMoqPublication = Static<typeof ScreenMoqPublicationSchema>;
export type ScreenMoqStatusResponse = Static<typeof ScreenMoqStatusResponseSchema>;
export type ScreenMoqConnectionResponse = Static<typeof ScreenMoqConnectionResponseSchema>;
export type ScreenMoqSubscribeRequest = Static<typeof ScreenMoqSubscribeRequestSchema>;
