import { afterEach, describe, expect, it } from 'vitest';

import {
  readViewerTransportPreference,
  saveViewerTransportPreference,
  viewerTransportPreferenceToIcePolicy,
  type ViewerTransportPreference
} from './viewer-transport-preference.js';

afterEach(() => localStorage.clear());

describe('viewer transport preference', () => {
  it('defaults to auto and ignores an unsupported persisted value', () => {
    localStorage.setItem('babagan.viewer-transport', 'p2p');

    expect(readViewerTransportPreference(localStorage)).toBe('auto');
  });

  it.each([
    ['auto', 'all'],
    ['turn', 'relay'],
    ['sfu', 'all']
  ] as const)('maps %s to the browser ICE policy %s', (preference, expected) => {
    expect(viewerTransportPreferenceToIcePolicy(preference)).toBe(expected);
  });

  it.each(['auto', 'turn', 'sfu'] as ViewerTransportPreference[])('persists the %s choice', (preference) => {
    saveViewerTransportPreference(localStorage, preference);

    expect(readViewerTransportPreference(localStorage)).toBe(preference);
  });
});
