import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyCodecArtifacts(directory) {
  const root = await realpath(resolve(directory));
  const manifestBytes = await readFile(join(root, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (typeof manifest.releaseReady !== 'boolean') throw new Error('missing release readiness metadata');
  if (manifest.source) {
    const observed = manifest.toolchain, pinned = manifest.source.emsdk;
    if (!/^[0-9a-f]{64}$/.test(manifest.wrapperSha256 ?? '') || !observed ||
      observed.version !== pinned?.version || observed.emsdkCommit !== pinned?.commit ||
      !observed.sdkRelease?.startsWith(`releases-${pinned?.release}-`)) {
      throw new Error('missing or mismatched compiler provenance');
    }
  }
  if (!manifest.artifacts || Object.keys(manifest.artifacts).length === 0) throw new Error('empty artifact manifest');
  const files = new Map([[join(root, 'manifest.json'), sha256(manifestBytes)]]);
  for (const [name, record] of Object.entries(manifest.artifacts)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error('invalid artifact filename');
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > 32 * 1024 * 1024 ||
      !/^[0-9a-f]{64}$/.test(record.sha256)) throw new Error('invalid artifact size or hash');
    const path = await realpath(join(root, name));
    if (!path.startsWith(root + sep)) throw new Error('artifact escapes verified directory');
    const bytes = await readFile(path);
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error(`artifact hash mismatch: ${name}`);
    files.set(join(root, name), record.sha256);
  }
  return { manifest, digest: sha256(manifestBytes), files };
}
