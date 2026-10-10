/* global URL, console */
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, dirname } from 'node:path';
import { verifyCodecArtifacts } from '../media/codec-artifacts.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
for (const name of ['openh264-2.6.0', 'libav-6.10.9']) {
  const input = resolve(root, 'artifacts/screen-codecs', name);
  const output = resolve(root, 'apps/web/public/screen-codecs', name);
  const verified = await verifyCodecArtifacts(input);
  if (!verified.manifest.releaseReady) throw new Error('Corresponding sources required before publishing codec package');
  for (const path of verified.files.keys()) {
    const target = resolve(output, relative(input, path));
    if (!target.startsWith(output)) throw new Error('Invalid codec publish path');
    await mkdir(dirname(target), { recursive: true });
    await copyFile(path, target);
  }
  console.log(`Published verified ${name} with corresponding sources`);
}
