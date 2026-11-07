/* global process, console, Buffer, URL */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRelease, signObject, verifyRelease, publicKeyPath } from './client-release-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), values = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--windows','--android','--destination','--sequence'].includes(args[i]) || !args[i + 1]) throw new Error('Expected --windows, --android, --destination, or --sequence values');
  values.set(args[i], args[i + 1]);
}
const sequence = Number(values.get('--sequence') ?? 1);
if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid release sequence');
const windowsRoot = resolve(root, values.get('--windows') ?? 'output/desktop-client');
const androidRoot = resolve(root, values.get('--android') ?? 'artifacts/android');
const destination = resolve(root, values.get('--destination') ?? 'apps/web/public/downloads/clients');
const rel = relative(root, destination);
if (isAbsolute(rel) || rel.startsWith('..') || !(rel.replaceAll('\\','/').startsWith('output/') || rel.replaceAll('\\','/').startsWith('apps/web/public/downloads/'))) throw new Error('Release staging must be in this repository output/downloads directory');
const key = JSON.parse(await readFile(publicKeyPath, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function artifact(from, metadata, target) {
  const bytes = await readFile(from);
  if (bytes.length !== metadata.bytes || hash(bytes) !== metadata.sha256) throw new Error(`Artifact changed: ${metadata.file}`);
  try { const old = await readFile(target); if (hash(old) !== metadata.sha256) throw new Error(`Refusing to overwrite immutable release artifact: ${target}`); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(resolve(target, '..'), { recursive: true });
  await copyFile(from, target);
}
async function feed(platform, version, item) {
  const release = { schema: 1, product: 'babagan-client', platform, channel: 'stable', sequence, version, releasedAt: new Date().toISOString(), minHostProtocol: 1,
    artifact: { url: `https://meet.babagan.cloud/downloads/clients/${platform}/${version}/${platform === 'windows' ? 'client.zip' : 'Babagan.apk'}`, sha256: item.sha256, bytes: item.bytes } };
  try {
    const priorEnvelope = JSON.parse(await readFile(resolve(destination, platform, 'stable.json'), 'utf8'));
    const prior = verifyRelease(priorEnvelope, key);
    if (sequence < prior.sequence) throw new Error('Refusing a release sequence rollback');
    if (sequence === prior.sequence) {
      if (prior.version !== version || prior.artifact.sha256 !== item.sha256 || prior.artifact.bytes !== item.bytes) throw new Error('Release sequence already identifies different content');
      return priorEnvelope;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const signed = await signRelease(release); verifyRelease(signed, key);
  await writeFile(resolve(destination, platform, 'stable.json'), JSON.stringify(signed, null, 2) + '\n');
  return signed;
}
const win = JSON.parse(await readFile(resolve(windowsRoot, 'release.json'), 'utf8'));
const android = JSON.parse(await readFile(resolve(androidRoot, 'release.json'), 'utf8'));
const associations = JSON.parse(await readFile(resolve(root, 'apps/web/public/.well-known/assetlinks.json'), 'utf8'));
const identity = associations.find(item => item.target?.package_name === 'cloud.babagan.meeting')?.target;
const signer = typeof android.apkSignerSha256 === 'string' ? android.apkSignerSha256.toLowerCase() : '';
if (!identity || android.applicationId !== identity.package_name || !identity.sha256_cert_fingerprints.some(value => value.replaceAll(':','').toLowerCase() === signer)
  || !Number.isSafeInteger(android.versionCode) || android.versionCode < 1) throw new Error('Android release is not signed with the established application identity');
if (win.dirty || android.source?.dirty || win.product !== 'babagan-client' || android.product !== 'babagan-client') throw new Error('Build both clients from a clean committed checkout before publishing');
if (win.sequence !== sequence) throw new Error('Windows payload sequence must match the signed feed');
if (win.source !== android.source.commit) throw new Error('Client artifacts come from different source commits');
for (const item of [win, android]) if (!/^\d+\.\d+\.\d+$/.test(item.version)) throw new Error('Invalid client version');
await mkdir(destination, { recursive: true });
await artifact(resolve(windowsRoot, win.zip.file), win.zip, resolve(destination, 'windows', win.version, 'client.zip'));
await artifact(resolve(windowsRoot, win.installer.file), win.installer, resolve(destination, 'windows', win.version, `BabaganClientSetup-${win.version}.exe`));
await artifact(resolve(androidRoot, android.artifact.file), android.artifact, resolve(destination, 'android', android.version, 'Babagan.apk'));
const windowsFeed = await feed('windows', win.version, win.zip);
const androidFeed = await feed('android', android.version, android.artifact);
const catalog = { schema: 1, releases: {
  windows: { available: true, version: win.version, url: `/downloads/clients/windows/${win.version}/BabaganClientSetup-${win.version}.exe`, sha256: win.installer.sha256, bytes: win.installer.bytes },
  android: { available: true, version: android.version, url: `/downloads/clients/android/${android.version}/Babagan.apk`, sha256: android.artifact.sha256, bytes: android.artifact.bytes }
} };
await writeFile(resolve(destination, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
const manifest = { schema: 1, product: 'babagan-client-release', sequence, source: win.source, releases: {
  windows: { version: win.version, artifacts: [
    { path: `windows/${win.version}/client.zip`, sha256: win.zip.sha256, bytes: win.zip.bytes },
    { path: `windows/${win.version}/BabaganClientSetup-${win.version}.exe`, sha256: win.installer.sha256, bytes: win.installer.bytes }
  ] },
  android: { version: android.version, artifacts: [{ path: `android/${android.version}/Babagan.apk`, sha256: android.artifact.sha256, bytes: android.artifact.bytes }] }
} };
await writeFile(resolve(destination, 'release-manifest.json'), JSON.stringify(await signObject(manifest), null, 2) + '\n');
await writeFile(resolve(destination, 'release-proof.json'), JSON.stringify({ source: win.source, keyId: key.keyId, sequence, versions: { windows: win.version, android: android.version },
  signedFeedSha256: { windows: hash(Buffer.from(JSON.stringify(windowsFeed))), android: hash(Buffer.from(JSON.stringify(androidFeed))) } }, null, 2) + '\n');
console.log(`Prepared signed client release sequence ${sequence}: Windows ${win.version}, Android ${android.version}. Publish immutable artifacts before replacing feeds.`);
