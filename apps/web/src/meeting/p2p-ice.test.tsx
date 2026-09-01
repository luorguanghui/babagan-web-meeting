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
      turnProvider: 'coturn',
      availableTurnProviders: ['coturn']
    });
  });

  it('uses the server-provided expiry for Cloudflare credentials', () => {
    const configuration = normalizeP2pIceServerConfiguration({
      iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'opaque', credential: 'secret' }],
      turnProvider: 'cloudflare',
      availableTurnProviders: ['coturn', 'cloudflare'],
      turnCredentialsExpiresAt: 1_000 + 600
    });

    expect(configuration.availableTurnProviders).toEqual(['coturn', 'cloudflare']);
    expect(iceConfigurationExpiresSoon(configuration, 1_000)).toBe(false);
    expect(iceConfigurationExpiresSoon(configuration, 1_540)).toBe(true);
  });

  it('defaults available providers for legacy responses', () => {
    expect(normalizeP2pIceServerConfiguration({
      iceServers: [{ urls: ['turn:turn.example.test:3478'], username: 'expiry:ada', credential: 'secret' }],
      turnProvider: 'coturn',
      availableTurnProviders: ['coturn']
    })).toEqual({
      iceServers: [{ urls: ['turn:turn.example.test:3478'], username: 'expiry:ada', credential: 'secret' }],
      turnProvider: 'coturn',
      availableTurnProviders: ['coturn']
    });
  });
});
