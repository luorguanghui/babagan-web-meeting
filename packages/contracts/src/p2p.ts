import { Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { SchemaError } from './errors.js';

export const P2P_ICE_NEGOTIATION_TIMEOUT_MS = 8000;
/** Deadline extension granted per ICE progress event while negotiating (candidate pair checks). */
export const P2P_ICE_NEGOTIATION_PROGRESS_TIMEOUT_MS = 8000;
/** Absolute ceiling for a negotiation from the first offer, including progress extensions and retries. */
export const P2P_ICE_NEGOTIATION_MAX_MS = 30_000;
export const P2P_ICE_DISCONNECT_TIMEOUT_MS = 5000;
export const P2P_RTP_STALL_TIMEOUT_MS = 5000;
export const P2P_MESSAGE_MAX_BYTES = 64 * 1024;
export const P2P_SCREEN_BITRATES = [5_000_000, 8_000_000, 10_000_000] as const;
/**
 * Sharer uplink safety cap for the whole P2P screen share: the selected tier
 * applies per viewer, but the sum of all live session caps never exceeds this
 * budget. 20 Mbps keeps a 4-viewer meeting at 5 Mbps each even on the maximum
 * tier while a measured 100 Mbps home uplink retains ample voice headroom.
 */
export const P2P_TOTAL_UPLINK_BUDGET_BPS = 20_000_000;

export type P2pScreenBitrate = typeof P2P_SCREEN_BITRATES[number];

export const P2P_TURN_PROVIDERS = ['coturn', 'cloudflare'] as const;
export type P2pTurnProvider = typeof P2P_TURN_PROVIDERS[number];

const IdentitySchema = Type.String({ minLength: 1, maxLength: 256 });
const GenerationSchema = Type.String({ minLength: 1, maxLength: 128 });
const SdpSchema = Type.String({ minLength: 1, maxLength: P2P_MESSAGE_MAX_BYTES });
const CandidateSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: P2P_MESSAGE_MAX_BYTES }),
  Type.Null()
]);

export const P2pClientMessageSchema = Type.Union([
  Type.Object({
    type: Type.Literal('hello'),
    participantIdentity: IdentitySchema
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('offer'),
    to: IdentitySchema,
    sdp: SdpSchema,
    generation: Type.Optional(GenerationSchema)
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('answer'),
    to: IdentitySchema,
    sdp: SdpSchema,
    generation: Type.Optional(GenerationSchema)
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('ice'),
    to: IdentitySchema,
    candidate: CandidateSchema,
    generation: Type.Optional(GenerationSchema)
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('media-ready'),
    to: IdentitySchema,
    generation: Type.Optional(GenerationSchema)
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('retry'),
    to: IdentitySchema
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('bye'),
    to: IdentitySchema,
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 }))
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('ping')
  }, { additionalProperties: false })
]);

export type P2pClientMessage = Static<typeof P2pClientMessageSchema>;

export const P2pServerMessageSchema = Type.Union([
  Type.Object({
    type: Type.Literal('welcome'),
    peers: Type.Array(Type.Object({
      identity: IdentitySchema,
      nickname: Type.String({ minLength: 1, maxLength: 40 })
    }, { additionalProperties: false }))
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('peer-joined'),
    peer: Type.Object({
      identity: IdentitySchema,
      nickname: Type.String({ minLength: 1, maxLength: 40 })
    }, { additionalProperties: false })
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('peer-left'),
    peer: Type.Object({
      identity: IdentitySchema
    }, { additionalProperties: false })
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('pong')
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('share-gone'),
    reason: Type.String({ minLength: 1 })
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('error'),
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 })
  }, { additionalProperties: false })
]);

export type P2pServerMessage = Static<typeof P2pServerMessageSchema>;

const textEncoder = new TextEncoder();

export function parseP2pClientMessage(raw: unknown): P2pClientMessage {
  try {
    if (serializedByteLength(raw) > P2P_MESSAGE_MAX_BYTES) {
      throw new SchemaError(`P2P client message exceeds ${P2P_MESSAGE_MAX_BYTES} bytes`);
    }
    if (!Value.Check(P2pClientMessageSchema, raw)) {
      throw new SchemaError('Invalid P2P client message');
    }
    return raw as P2pClientMessage;
  } catch (error) {
    if (error instanceof SchemaError) {
      throw error;
    }
    throw new SchemaError('Invalid P2P client message');
  }
}

function serializedByteLength(value: unknown): number {
  try {
    return textEncoder.encode(JSON.stringify(value) ?? '').length;
  } catch {
    return -1; // not JSON-serializable; let the schema check reject it
  }
}
