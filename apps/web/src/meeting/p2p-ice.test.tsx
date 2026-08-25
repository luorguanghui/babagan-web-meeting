import { describe, expect, it } from 'vitest';

import {
  iceConfigurationExpiresSoon,
  normalizeP2pIceServerConfiguration
} from './p2p-ice.js';

describe('P2P ICE server configuration', () => {
  it('keeps legacy ICE responses on the coturn provider', () => {
    expect(normalizeP2pIceServerConfiguration([
      { urls: ['turn:turn.example.test:3478'], username: 'expiry:ada', credential: 'secret' }
    ])).toEqual({
      iceServers: [{ urls: ['turn:turn.example.test:3478'], username: 'expiry:ada', credential: 'secret' }],
      turnProvider: 'coturn'
    });
  });

  it('uses the server-provided expiry for Cloudflare credentials', () => {
    const configuration = normalizeP2pIceServerConfiguration({
      iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'opaque', credential: 'secret' }],
      turnProvider: 'cloudflare',
      turnCredentialsExpiresAt: 1_000 + 600
    });

    expect(iceConfigurationExpiresSoon(configuration, 1_000)).toBe(false);
    expect(iceConfigurationExpiresSoon(configuration, 1_540)).toBe(true);
  });
});
