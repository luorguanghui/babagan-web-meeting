/** Refresh margin kept before a TURN credential expiry so a refresh never races the clock. */
export const ICE_CREDENTIALS_REFRESH_MARGIN_SECONDS = 60;

/**
 * Parses the coturn `use-auth-secret` username (`<expirySeconds>:<identity>`)
 * from the first ICE server that carries one, returning the credential expiry
 * as a Unix epoch in seconds. Returns `undefined` when no server exposes an
 * expiry (e.g. a bare STUN server).
 */
export function turnCredentialsExpirySeconds(iceServers: RTCIceServer[]): number | undefined {
  for (const server of iceServers) {
    if (typeof server.username !== 'string') continue;
    const match = /^(\d+):/.exec(server.username);
    if (!match) continue;
    const expiry = Number(match[1]);
    // Real epoch seconds are well past 1e9; anything smaller is not an expiry.
    if (Number.isFinite(expiry) && expiry > 1_000_000_000) return expiry;
  }
  return undefined;
}

/**
 * True when the cached ICE credentials carry a TURN expiry that is at (or
 * within the margin of) `nowSeconds`. Expired credentials make ICE gathering
 * skip relay candidates silently, which is exactly the failure that leaves a
 * long-lived meeting unable to P2P when the direct path is unavailable.
 */
export function iceCredentialsExpireSoon(
  iceServers: RTCIceServer[],
  nowSeconds: number = Date.now() / 1_000
): boolean {
  const expiry = turnCredentialsExpirySeconds(iceServers);
  return expiry !== undefined && expiry <= nowSeconds + ICE_CREDENTIALS_REFRESH_MARGIN_SECONDS;
}
