import { describe, expect, it } from 'vitest';

import {
  canRetryViewerScreenTransport,
  deriveSharerScreenTransportMode,
  deriveSharerTurnProvider,
  deriveViewerScreenTransportMode,
  deriveViewerTurnProvider
} from './screen-transport-mode.js';

describe('screen transport mode', () => {
  it.each([
    ['idle', false],
    ['p2p', false],
    ['negotiating', true],
    ['turn', true],
    ['livekit', true]
  ] as const)('derives manual retry visibility for viewer state %s', (state, expected) => {
    expect(canRetryViewerScreenTransport(state)).toBe(expected);
  });

  it.each([
    ['idle', 'sfu'],
    ['negotiating', 'negotiating'],
    ['p2p', 'p2p'],
    ['turn', 'turn'],
    ['livekit', 'sfu']
  ] as const)('maps viewer state %s to %s', (state, expected) => {
    expect(deriveViewerScreenTransportMode(state)).toBe(expected);
  });

  it('shows waiting when the sharer has no active viewers', () => {
    expect(deriveSharerScreenTransportMode(new Map())).toBe('waiting');
    expect(deriveSharerScreenTransportMode(new Map([['left', 'closed']]))).toBe('waiting');
  });

  it.each([
    ['negotiating', 'negotiating'],
    ['p2p', 'p2p'],
    ['turn', 'turn'],
    ['livekit-fallback', 'sfu']
  ] as const)('shows a homogeneous sharer state %s as %s', (state, expected) => {
    expect(deriveSharerScreenTransportMode(new Map([
      ['viewer-1', state],
      ['viewer-2', state]
    ]))).toBe(expected);
  });

  it('shows mixed when viewers use different transports or one is still negotiating', () => {
    expect(deriveSharerScreenTransportMode(new Map([
      ['viewer-1', 'p2p'],
      ['viewer-2', 'turn'],
      ['viewer-3', 'livekit-fallback']
    ]))).toBe('mixed');
    expect(deriveSharerScreenTransportMode(new Map([
      ['viewer-1', 'p2p'],
      ['viewer-2', 'negotiating']
    ]))).toBe('mixed');
  });

  it('keeps the actual TURN provider visible for viewers and sharers', () => {
    expect(deriveViewerTurnProvider('turn', 'cloudflare')).toBe('cloudflare');
    expect(deriveViewerTurnProvider('p2p', 'cloudflare')).toBeUndefined();
    expect(deriveSharerTurnProvider(
      new Map([['viewer-1', 'turn'], ['viewer-2', 'turn']]),
      new Map([['viewer-1', 'cloudflare'], ['viewer-2', 'cloudflare']])
    )).toBe('cloudflare');
    expect(deriveSharerTurnProvider(
      new Map([['viewer-1', 'turn'], ['viewer-2', 'turn']]),
      new Map([['viewer-1', 'cloudflare'], ['viewer-2', 'coturn']])
    )).toBe('mixed');
  });
});
