/* global process, console, Buffer, URL */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export const publicKeyPath = join(root, 'scripts/client-update-public-key.json');
export const privateKeyPath = () => process.env.BABAGAN_CLIENT_UPDATE_KEY ?? join(process.env.LOCALAPPDATA ?? '', 'Babagan', 'signing', 'client-updates-private.pem');
export async function initializeUpdateKey() {
  const keyPath = privateKeyPath();
  if (!process.env.LOCALAPPDATA && !process.env.BABAGAN_CLIENT_UPDATE_KEY) throw new Error('Choose a private key path outside the repository.');
  if (resolve(keyPath).startsWith(resolve(root))) throw new Error('The private update key must stay outside the repository.');
  await mkdir(resolve(keyPath, '..'), { recursive: true });
  let privateKey;
  try { privateKey = createPrivateKey(await readFile(keyPath)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    privateKey = generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey;
    await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  }
  const key = createPublicKey(privateKey), spki = key.export({ type: 'spki', format: 'der' }), jwk = key.export({ format: 'jwk' });
  const publicConfig = { schema: 1, keyId: `babagan-${createHash('sha256').update(spki).digest('hex').slice(0, 16)}`, algorithm: 'RS256',
    spkiBase64: spki.toString('base64'), modulusBase64: Buffer.from(jwk.n, 'base64url').toString('base64'), exponentBase64: Buffer.from(jwk.e, 'base64url').toString('base64') };
  try {
    await access(publicKeyPath);
    const old = JSON.parse(await readFile(publicKeyPath, 'utf8'));
    if (old.keyId !== publicConfig.keyId) throw new Error('Refusing to replace the published update identity. Use an explicit key-rotation release.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(publicKeyPath, JSON.stringify(publicConfig, null, 2) + '\n');
  return publicConfig;
}
export function validateRelease(payload) {
  if (!payload || payload.schema !== 1 || payload.product !== 'babagan-client' || !['windows','android'].includes(payload.platform)
    || payload.channel !== 'stable' || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1
    || !/^\d+\.\d+\.\d+$/.test(payload.version) || !Number.isFinite(Date.parse(payload.releasedAt)) || payload.minHostProtocol !== 1) throw new Error('Invalid client release metadata');
  const artifact = payload.artifact;
  const expected = `https://meet.babagan.cloud/downloads/clients/${payload.platform}/${payload.version}/${payload.platform === 'windows' ? 'client.zip' : 'Babagan.apk'}`;
  if (!artifact || artifact.url !== expected || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes)
    || artifact.bytes < 1 || artifact.bytes > 400_000_000) throw new Error('Invalid client update artifact');
  return payload;
}
export async function signRelease(payload) {
  validateRelease(payload);
  const envelope = await signObject(payload);
  const key = JSON.parse(await readFile(publicKeyPath, 'utf8'));
  verifyRelease(envelope, key); return envelope;
}
export async function signObject(payload) {
  const key = JSON.parse(await readFile(publicKeyPath, 'utf8'));
  const bytes = Buffer.from(JSON.stringify(payload));
  const privateKey = createPrivateKey(await readFile(privateKeyPath()));
  const signature = sign('RSA-SHA256', bytes, privateKey);
  const envelope = { schema: 1, keyId: key.keyId, payloadBase64: bytes.toString('base64'), signatureBase64: signature.toString('base64') };
  return envelope;
}
export function verifyRelease(envelope, key) {
  if (!envelope || envelope.schema !== 1 || envelope.keyId !== key.keyId || typeof envelope.payloadBase64 !== 'string'
    || typeof envelope.signatureBase64 !== 'string' || envelope.payloadBase64.length > 16384 || envelope.signatureBase64.length > 2048) throw new Error('Invalid signed release envelope');
  const bytes = Buffer.from(envelope.payloadBase64, 'base64');
  if (!verify('RSA-SHA256', bytes, createPublicKey({ key: Buffer.from(key.spkiBase64, 'base64'), type: 'spki', format: 'der' }), Buffer.from(envelope.signatureBase64, 'base64'))) throw new Error('Client update signature mismatch');
  return validateRelease(JSON.parse(bytes.toString('utf8')));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--init-key') throw new Error('Use --init-key to prepare the local release signing identity.');
  const key = await initializeUpdateKey(); console.log(`Client update public identity prepared: ${key.keyId}. Private key kept outside the repository.`);
}
