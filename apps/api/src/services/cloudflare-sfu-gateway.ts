const trustedGateways = new Set([
  'https://p2p.babagan.cloud/api/sfu',
  'https://babagan-p2p.1312479965.workers.dev/api/sfu'
]);

/** Accept only the operator's existing Worker with a fixed SFU route prefix. */
export function validateCloudflareSfuGateway(value: string | undefined): string | undefined {
  const gatewayUrl = value?.trim() || undefined;
  if (gatewayUrl && !trustedGateways.has(gatewayUrl)) {
    throw new Error('CLOUDFLARE_SFU_GATEWAY_URL must be a trusted HTTPS SFU gateway');
  }
  return gatewayUrl;
}
