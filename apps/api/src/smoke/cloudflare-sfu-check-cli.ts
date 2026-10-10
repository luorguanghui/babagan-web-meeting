import { pathToFileURL } from 'node:url';
import { loadConfig, type AppConfig } from '../config.js';
import { domainError } from '../domain/errors.js';
import { CloudflareSfuClient } from '../services/cloudflare-sfu-client.js';

export async function verifyCloudflareSfu(config: Pick<AppConfig, 'cloudflareSfuAppId' | 'cloudflareSfuAppSecret' | 'cloudflareSfuGatewayUrl'>): Promise<string> {
  if (!config.cloudflareSfuGatewayUrl && (!config.cloudflareSfuAppId || !config.cloudflareSfuAppSecret)) throw domainError('MEDIA_SERVICE_UNAVAILABLE');
  const client = new CloudflareSfuClient({ appId: config.cloudflareSfuAppId, appSecret: config.cloudflareSfuAppSecret, gatewayUrl: config.cloudflareSfuGatewayUrl });
  try { await client.createSession(); return 'CLOUDFLARE_SFU_AUTH_OK'; }
  finally { await client.close(); }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  try { process.stdout.write(`${await verifyCloudflareSfu(loadConfig(process.env))}\n`); }
  catch { process.stderr.write('CLOUDFLARE_SFU_AUTH_FAILED\n'); process.exitCode = 1; }
}
