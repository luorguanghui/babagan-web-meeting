import { describe, expect, it } from 'vitest';

import {
  ICE_CREDENTIALS_REFRESH_MARGIN_SECONDS,
  iceCredentialsExpireSoon,
  turnCredentialsExpirySeconds
} from './ice-credentials.js';

describe('ice credential expiry', () => {
  it('parses the expiry epoch from the coturn username', () => {
    expect(turnCredentialsExpirySeconds([
      { urls: ['stun:stun.example.test:3478'] },
      { urls: ['turn:turn.example.test:3478'], username: '1785000000:ada', credential: 'secret' }
    ])).toBe(1_785_000_000);
  });

  it('returns undefined for STUN-only lists and non-epoch usernames', () => {
    expect(turnCredentialsExpirySeconds([{ urls: ['stun:stun.example.test:3478'] }])).toBeUndefined();
    expect(turnCredentialsExpirySeconds([])).toBeUndefined();
    expect(turnCredentialsExpirySeconds([
      { urls: ['turn:turn.example.test:3478'], username: 'not-a-credential', credential: 'secret' }
    ])).toBeUndefined();
    // Small numbers are not epoch seconds.
    expect(turnCredentialsExpirySeconds([
      { urls: ['turn:turn.example.test:3478'], username: '42:ada', credential: 'secret' }
    ])).toBeUndefined();
  });

  it('flags credentials that expire within the refresh margin', () => {
    const soon = [{ urls: ['turn:turn.example.test:3478'], username: '1785000060:ada', credential: 'secret' }];
    const fresh = [{ urls: ['turn:turn.example.test:3478'], username: '1785003600:ada', credential: 'secret' }];
    const now = 1_785_000_000;

    expect(iceCredentialsExpireSoon(soon, now)).toBe(true);
    expect(iceCredentialsExpireSoon(
      [{ urls: ['turn:turn.example.test:3478'], username: `17850000${ICE_CREDENTIALS_REFRESH_MARGIN_SECONDS + 61}:ada`, credential: 'secret' }],
      now
    )).toBe(false);
    expect(iceCredentialsExpireSoon(fresh, now)).toBe(false);
    expect(iceCredentialsExpireSoon([{ urls: ['stun:stun.example.test:3478'] }], now)).toBe(false);
  });
});
