import type { P2pTurnProvider } from '@meeting/contracts';

import { iceCredentialsExpireSoon } from './ice-credentials.js';

export interface P2pIceServerConfiguration {
  iceServers: RTCIceServer[];
  turnProvider: P2pTurnProvider;
  availableTurnProviders?: P2pTurnProvider[];
  turnCredentialsExpiresAt?: number;
}

export function normalizeP2pIceServerConfiguration(
  value: RTCIceServer[] | P2pIceServerConfiguration
): P2pIceServerConfiguration {
  return Array.isArray(value)
    ? { iceServers: value, turnProvider: 'coturn', availableTurnProviders: ['coturn'] }
    : {
      iceServers: value.iceServers,
      turnProvider: value.turnProvider ?? 'coturn',
      availableTurnProviders: value.availableTurnProviders ?? ['coturn'],
      turnCredentialsExpiresAt: value.turnCredentialsExpiresAt
    };
}

export function iceConfigurationExpiresSoon(
  configuration: P2pIceServerConfiguration,
  nowSeconds = Date.now() / 1_000
): boolean {
  if (configuration.turnCredentialsExpiresAt !== undefined) {
    return configuration.turnCredentialsExpiresAt <= nowSeconds + 60;
  }
  return iceCredentialsExpireSoon(configuration.iceServers, nowSeconds);
}
