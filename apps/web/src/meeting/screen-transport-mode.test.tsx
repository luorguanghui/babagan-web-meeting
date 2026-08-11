import { describe, expect, it } from 'vitest';

import {
  deriveSharerScreenTransportMode,
  deriveViewerScreenTransportMode
} from './screen-transport-mode.js';

describe('screen transport mode', () => {
  it.each([
    ['idle', 'sfu'],
    ['negotiating', 'negotiating'],
    ['p2p', 'p2p'],
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
});
