import { beforeEach, describe, expect, it } from 'vitest';

import {
  readScreenShareTurnProviderPreference,
  saveScreenShareTurnProviderPreference
} from './screen-turn-provider-preference.js';

beforeEach(() => {
  window.localStorage.clear();
});

describe('screen TURN provider preference', () => {
  it('defaults to auto and ignores unsupported persisted values', () => {
    window.localStorage.setItem('babagan.screen-turn-provider', 'invalid');

    expect(readScreenShareTurnProviderPreference(window.localStorage)).toBe('auto');
  });

  it.each(['auto', 'coturn', 'cloudflare'] as const)('persists %s', (preference) => {
    saveScreenShareTurnProviderPreference(window.localStorage, preference);

    expect(readScreenShareTurnProviderPreference(window.localStorage)).toBe(preference);
  });
});
