import { Type, type Static } from '@sinclair/typebox';

const identifier = Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' });
const mid = Type.String({ minLength: 1, maxLength: 32, pattern: '^[A-Za-z0-9_-]+$' });
const trackName = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' });
const kind = Type.Union([Type.Literal('video'), Type.Literal('audio')]);
const sdp = Type.String({ minLength: 1, maxLength: 65536 });
export const CloudflareSfuPublicationSchema = Type.Object({
  shareId: identifier, sessionId: identifier,
  sharerIdentity: Type.String({ minLength: 1, maxLength: 256 }),
  sharerName: Type.String({ minLength: 1, maxLength: 40 }),
  tracks: Type.Array(Type.Object({ kind, trackName }, { additionalProperties: false }), { minItems: 1, maxItems: 2 })
}, { additionalProperties: false });
export type CloudflareSfuPublication = Static<typeof CloudflareSfuPublicationSchema>;
export const CloudflareSfuStatusResponseSchema = Type.Object({
  available: Type.Boolean(), publication: Type.Union([CloudflareSfuPublicationSchema, Type.Null()])
}, { additionalProperties: false });
export type CloudflareSfuStatusResponse = Static<typeof CloudflareSfuStatusResponseSchema>;
export const CloudflareSfuPublishRequestSchema = Type.Object({
  sessionDescription: Type.Object({ type: Type.Literal('offer'), sdp }, { additionalProperties: false }),
  tracks: Type.Array(Type.Object({ kind, mid }, { additionalProperties: false }), { minItems: 1, maxItems: 2 })
}, { additionalProperties: false });
export type CloudflareSfuPublishRequest = Static<typeof CloudflareSfuPublishRequestSchema>;
export const CloudflareSfuReadyRequestSchema = Type.Object({ sessionId: identifier }, { additionalProperties: false });
export type CloudflareSfuReadyRequest = Static<typeof CloudflareSfuReadyRequestSchema>;
export const CloudflareSfuSubscribeRequestSchema = Type.Object({ shareId: identifier }, { additionalProperties: false });
export type CloudflareSfuSubscribeRequest = Static<typeof CloudflareSfuSubscribeRequestSchema>;
export const CloudflareSfuAnswerRequestSchema = Type.Object({
  sessionDescription: Type.Object({ type: Type.Literal('answer'), sdp }, { additionalProperties: false })
}, { additionalProperties: false });
export type CloudflareSfuAnswerRequest = Static<typeof CloudflareSfuAnswerRequestSchema>;
export const CloudflareSfuSessionResponseSchema = Type.Object({
  sessionId: identifier, shareId: identifier,
  sessionDescription: Type.Object({ type: Type.Union([Type.Literal('offer'), Type.Literal('answer')]), sdp }, { additionalProperties: false }),
  tracks: Type.Array(Type.Object({ kind, mid, trackName }, { additionalProperties: false }), { minItems: 1, maxItems: 2 })
}, { additionalProperties: false });
export type CloudflareSfuSessionResponse = Static<typeof CloudflareSfuSessionResponseSchema>;
