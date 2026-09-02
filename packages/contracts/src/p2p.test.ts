import { Value } from '@sinclair/typebox/value';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ApiErrorCodeSchema,
  ApiErrorResponseSchema,
  P2P_ICE_DISCONNECT_TIMEOUT_MS,
  P2P_ICE_NEGOTIATION_TIMEOUT_MS,
  P2P_MESSAGE_MAX_BYTES,
  P2P_SCREEN_BITRATES,
  P2P_TOTAL_UPLINK_BUDGET_BPS,
  P2pClientMessage,
  P2pClientMessageSchema,
  P2pScreenBitrate,
  P2pServerMessage,
  P2pServerMessageSchema,
  SchemaError,
  parseP2pClientMessage
} from './index.js';

describe('P2P signaling contract types', () => {
  it('exports the exact client-message discriminated union', () => {
    expectTypeOf<P2pClientMessage>().toEqualTypeOf<
      | { type: 'hello'; participantIdentity: string }
      | { type: 'offer'; to: string; sdp: string; generation?: string; turnProvider?: 'coturn' | 'cloudflare' }
      | { type: 'answer'; to: string; sdp: string; generation?: string }
      | { type: 'ice'; to: string; candidate: string | null; generation?: string } // null = end-of-candidates
      | { type: 'media-ready'; to: string; generation?: string }
      | { type: 'retry'; to: string }
      | { type: 'bye'; to: string; reason?: string }
      | { type: 'ping' }
    >();
  });

  it('exports the exact server-message discriminated union', () => {
    expectTypeOf<P2pServerMessage>().toEqualTypeOf<
      | { type: 'welcome'; peers: Array<{ identity: string; nickname: string }> }
      | { type: 'peer-joined'; peer: { identity: string; nickname: string } }
      | { type: 'peer-left'; peer: { identity: string } }
      | { type: 'pong' }
      | { type: 'share-gone'; reason: string }
      | { type: 'error'; code: string; message: string }
    >();
  });

  it('exports the exact screen-bitrate union', () => {
    expectTypeOf<P2pScreenBitrate>().toEqualTypeOf<5_000_000 | 8_000_000 | 10_000_000>();
  });

  it('exports the signaling constants with the specified values', () => {
    expect(P2P_ICE_NEGOTIATION_TIMEOUT_MS).toBe(8000);
    expect(P2P_ICE_DISCONNECT_TIMEOUT_MS).toBe(5000);
    expect(P2P_MESSAGE_MAX_BYTES).toBe(64 * 1024);
    expect(P2P_SCREEN_BITRATES).toEqual([5_000_000, 8_000_000, 10_000_000]);
    expect(P2P_TOTAL_UPLINK_BUDGET_BPS).toBe(40_000_000);
  });
});

describe('P2P client message schema', () => {
  it('accepts every documented client message', () => {
    expect(Value.Check(P2pClientMessageSchema, { type: 'hello', participantIdentity: 'participant-1' })).toBe(true);
    expect(Value.Check(P2pClientMessageSchema, { type: 'offer', to: 'viewer-1', sdp: 'v=0 ...' })).toBe(true);
    expect(Value.Check(P2pClientMessageSchema, {
      type: 'offer',
      to: 'viewer-1',
      sdp: 'v=0 ...',
      turnProvider: 'cloudflare'
    })).toBe(true);
    expect(Value.Check(P2pClientMessageSchema, { type: 'answer', to: 'sharer-1', sdp: 'v=0 ...' })).toBe(true);
    expect(Value.Check(P2pClientMessageSchema, { type: 'ice', to: 'sharer-1', candidate: 'candidate:1 1 udp 2130706431 192.0.2.1 54666 typ host' })).toBe(true);
    expect(Value.Check(P2pClientMessageSchema, { type: 'ice', to: 'sharer-1', candidate: null })).toBe(true);
    expect(Value.Check(P2pClientMessageSchema, { type: 'media-ready', to: 'sharer-1' })).toBe(true);
    expect(Value.Check(P2pClientMessageSchema, { type: 'retry', to: 'sharer-1' })).toBe(true);
    expect(Value.Check(P2pClientMessageSchema, { type: 'bye', to: 'viewer-1' })).toBe(true);
    expect(Value.Check(P2pClientMessageSchema, { type: 'bye', to: 'viewer-1', reason: 'fallback' })).toBe(true);
    expect(Value.Check(P2pClientMessageSchema, { type: 'ping' })).toBe(true);
  });

  it('rejects messages missing to, with unknown types, empty sdp, or extra properties', () => {
    expect(Value.Check(P2pClientMessageSchema, { type: 'offer', sdp: 'v=0 ...' })).toBe(false);
    expect(Value.Check(P2pClientMessageSchema, {
      type: 'offer',
      to: 'viewer-1',
      sdp: 'v=0 ...',
      turnProvider: 'unknown'
    })).toBe(false);
    expect(Value.Check(P2pClientMessageSchema, { type: 'answer', sdp: 'v=0 ...' })).toBe(false);
    expect(Value.Check(P2pClientMessageSchema, { type: 'ice', candidate: null })).toBe(false);
    expect(Value.Check(P2pClientMessageSchema, { type: 'bye' })).toBe(false);
    expect(Value.Check(P2pClientMessageSchema, { type: 'unknown' })).toBe(false);
    expect(Value.Check(P2pClientMessageSchema, { type: 'hello' })).toBe(false);
    expect(Value.Check(P2pClientMessageSchema, { type: 'offer', to: 'viewer-1', sdp: '' })).toBe(false);
    expect(Value.Check(P2pClientMessageSchema, { type: 'ping', extra: true })).toBe(false);
    expect(Value.Check(P2pClientMessageSchema, 'not-an-object')).toBe(false);
  });
});

describe('parseP2pClientMessage', () => {
  it('returns the message unchanged for every valid variant', () => {
    expect(parseP2pClientMessage({ type: 'hello', participantIdentity: 'participant-1' })).toEqual({
      type: 'hello', participantIdentity: 'participant-1'
    });
    expect(parseP2pClientMessage({ type: 'offer', to: 'viewer-1', sdp: 'v=0 ...' })).toEqual({
      type: 'offer', to: 'viewer-1', sdp: 'v=0 ...'
    });
    expect(parseP2pClientMessage({
      type: 'offer',
      to: 'viewer-1',
      sdp: 'v=0 ...',
      turnProvider: 'cloudflare'
    })).toEqual({
      type: 'offer',
      to: 'viewer-1',
      sdp: 'v=0 ...',
      turnProvider: 'cloudflare'
    });
    expect(parseP2pClientMessage({ type: 'answer', to: 'sharer-1', sdp: 'v=0 ...' })).toEqual({
      type: 'answer', to: 'sharer-1', sdp: 'v=0 ...'
    });
    expect(parseP2pClientMessage({ type: 'ice', to: 'sharer-1', candidate: 'candidate:1 1 udp 2130706431 192.0.2.1 54666 typ host' })).toEqual({
      type: 'ice', to: 'sharer-1', candidate: 'candidate:1 1 udp 2130706431 192.0.2.1 54666 typ host'
    });
    expect(parseP2pClientMessage({ type: 'ice', to: 'sharer-1', candidate: null })).toEqual({
      type: 'ice', to: 'sharer-1', candidate: null
    });
    expect(parseP2pClientMessage({ type: 'media-ready', to: 'sharer-1' })).toEqual({
      type: 'media-ready', to: 'sharer-1'
    });
    expect(parseP2pClientMessage({ type: 'bye', to: 'viewer-1' })).toEqual({ type: 'bye', to: 'viewer-1' });
    expect(parseP2pClientMessage({ type: 'bye', to: 'viewer-1', reason: 'fallback' })).toEqual({
      type: 'bye', to: 'viewer-1', reason: 'fallback'
    });
    expect(parseP2pClientMessage({ type: 'ping' })).toEqual({ type: 'ping' });
  });

  it('throws SchemaError for malformed or unauthorized messages', () => {
    expect(() => parseP2pClientMessage({ type: 'offer', sdp: 'v=0 ...' })).toThrow(SchemaError);
    expect(() => parseP2pClientMessage({ type: 'answer', sdp: 'v=0 ...' })).toThrow(SchemaError);
    expect(() => parseP2pClientMessage({ type: 'ice', candidate: null })).toThrow(SchemaError);
    expect(() => parseP2pClientMessage({ type: 'bye' })).toThrow(SchemaError);
    expect(() => parseP2pClientMessage({ type: 'unknown' })).toThrow(SchemaError);
    expect(() => parseP2pClientMessage({ type: 'hello' })).toThrow(SchemaError);
    expect(() => parseP2pClientMessage({ type: 'offer', to: 'viewer-1', sdp: '' })).toThrow(SchemaError);
    expect(() => parseP2pClientMessage({ type: 'ping', extra: true })).toThrow(SchemaError);
    expect(() => parseP2pClientMessage('not-an-object')).toThrow(SchemaError);
    expect(() => parseP2pClientMessage(null)).toThrow(SchemaError);
  });

  it('rejects messages whose sdp field exceeds the 64 KiB limit', () => {
    expect(() => parseP2pClientMessage({
      type: 'offer', to: 'viewer-1', sdp: 'x'.repeat(P2P_MESSAGE_MAX_BYTES + 1)
    })).toThrow(SchemaError);
  });

  it('rejects messages whose serialized size exceeds 64 KiB even when each field fits', () => {
    expect(() => parseP2pClientMessage({
      type: 'offer', to: 'viewer-1', sdp: 'x'.repeat(P2P_MESSAGE_MAX_BYTES)
    })).toThrow(SchemaError);
  });

  it('accepts a large-but-bounded offer near the limit', () => {
    expect(parseP2pClientMessage({ type: 'offer', to: 'viewer-1', sdp: 'x'.repeat(60_000) }).type).toBe('offer');
  });
});

describe('SchemaError', () => {
  it('is an Error subclass carrying the SchemaError name', () => {
    const error = new SchemaError('boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SchemaError');
    expect(error.message).toBe('boom');
  });
});

describe('P2P server message schema', () => {
  it('accepts every documented server message', () => {
    expect(Value.Check(P2pServerMessageSchema, {
      type: 'welcome', peers: [{ identity: 'participant-1', nickname: 'Ada' }]
    })).toBe(true);
    expect(Value.Check(P2pServerMessageSchema, {
      type: 'peer-joined', peer: { identity: 'participant-2', nickname: 'Bob' }
    })).toBe(true);
    expect(Value.Check(P2pServerMessageSchema, { type: 'peer-left', peer: { identity: 'participant-2' } })).toBe(true);
    expect(Value.Check(P2pServerMessageSchema, { type: 'pong' })).toBe(true);
    expect(Value.Check(P2pServerMessageSchema, { type: 'share-gone', reason: 'revoked' })).toBe(true);
    expect(Value.Check(P2pServerMessageSchema, { type: 'error', code: 'P2P_FORBIDDEN', message: 'denied' })).toBe(true);
  });

  it('rejects unknown server message types', () => {
    expect(Value.Check(P2pServerMessageSchema, { type: 'pong', extra: true })).toBe(false);
    expect(Value.Check(P2pServerMessageSchema, { type: 'teleport' })).toBe(false);
  });
});

describe('P2P error codes', () => {
  it('includes P2P_FORBIDDEN and P2P_PEER_NOT_FOUND in the public error code union', () => {
    expect(Value.Check(ApiErrorCodeSchema, 'P2P_FORBIDDEN')).toBe(true);
    expect(Value.Check(ApiErrorCodeSchema, 'P2P_PEER_NOT_FOUND')).toBe(true);
    expect(Value.Check(ApiErrorResponseSchema, {
      error: { code: 'P2P_PEER_NOT_FOUND', message: 'peer offline', correlationId: 'request-1' }
    })).toBe(true);
    expect(Value.Check(ApiErrorResponseSchema, {
      error: { code: 'P2P_INVALID_SCOPE', message: 'no', correlationId: 'request-1' }
    })).toBe(false);
  });
});
