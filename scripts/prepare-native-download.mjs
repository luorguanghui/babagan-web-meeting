/* global process, console, URL */
import { readFile, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, process.argv[2] ?? 'output/native-installer');
const release = JSON.parse(await readFile(resolve(source, 'release.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(release.version) || release.file !== 'BabaganSetup.exe') throw new Error('Invalid native release');
const file = resolve(source, release.file), bytes = await readFile(file);
if (createHash('sha256').update(bytes).digest('hex') !== release.sha256 || bytes.length !== release.bytes) throw new Error('Native installer hash mismatch');
const destination = resolve(root, 'apps/web/public/downloads'); await mkdir(destination, { recursive: true });
const name = `BabaganSetup-${release.version}.exe`;
await copyFile(file, resolve(destination, name));
await writeFile(resolve(destination, 'native-release.json'), JSON.stringify({ version: release.version, url: `/downloads/${name}`, sha256: release.sha256, bytes: bytes.length }, null, 2) + '\n');
const runtimes = JSON.parse(await readFile(resolve(root, 'scripts/native-runtime-artifacts.json'), 'utf8'));
const cache = resolve(root, process.argv[3] ?? 'output/native-installer-downloads');
await mkdir(resolve(destination, 'runtime'), { recursive: true });
for (const runtime of runtimes) {
  if (!/^[a-zA-Z0-9_.-]+\.zip$/.test(runtime.file) || !/^[a-f0-9]{64}$/.test(runtime.sha256)) throw new Error('Invalid runtime manifest');
  const archive = resolve(cache, `${runtime.sha256}.zip`), data = await readFile(archive);
  if (data.length !== runtime.bytes || createHash('sha256').update(data).digest('hex') !== runtime.sha256) throw new Error(`Runtime hash mismatch: ${runtime.file}`);
  await copyFile(archive, resolve(destination, 'runtime', runtime.file));
}
await writeFile(resolve(destination, 'runtime', 'sources.json'), JSON.stringify(runtimes, null, 2) + '\n');
await writeFile(resolve(destination, 'runtime', 'README.txt'), 'Babagan runtime mirror\n\nOriginal, unmodified provider archives; SHA-256 and exact sources in sources.json.\nNode.js: the archive contains LICENSE with Node.js and bundled dependency notices.\nFFmpeg: Gyan essentials build, GPLv3; archive LICENSE and README.txt include licensing, exact source revision and build configuration.\nUpstream build/source information: https://www.gyan.dev/ffmpeg/builds/\nThese archives are downloaded to the current user directory. No global runtime or PATH is modified.\n');
console.log(`Prepared verified download ${name}`);
