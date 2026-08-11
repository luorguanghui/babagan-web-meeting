import { describe, expect, it } from 'vitest';

import { createTurnCredentials } from './turn-credentials.js';

describe('createTurnCredentials', () => {
  it('creates a participant-bound coturn REST credential with a fixed expiry', () => {
    expect(createTurnCredentials({
      secret: '0123456789abcdef0123456789abcdef',
      participantIdentity: 'participant-1',
      ttlSeconds: 600,
      nowSeconds: 1_000
    })).toEqual({
      username: '1600:participant-1',
      credential: 'fzpSKm8rj6hqheC+/CHLjtJRpQs='
    });
  });
});
