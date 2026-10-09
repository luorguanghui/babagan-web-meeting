import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-codec-artifact-test-'));
  try {
    const data = new Uint8Array([0, 97, 115, 109]);
    const manifest = { package: '@libav.js/variant-vp8-opus', version: '6.10.9', releaseReady: false,
      artifacts: { 'encoder.wasm': { bytes: 4, sha256: createHash('sha256').update(data).digest('hex') } } };
    await writeFile(join(directory, 'encoder.wasm'), data);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await callback(directory, manifest);
  } finally {
    await removeFixture(directory);
  }
}

async function removeFixture(directory) {
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe temporary directory cleanup');
  await rm(directory, { recursive: true });
}

test('identifies exact manifest and rejects replaced module bytes', async () => {
  const { verifyCodecArtifacts } = await import('../media/codec-artifacts.mjs');
  await fixture(async directory => {
    const verified = await verifyCodecArtifacts(directory);
    assert.match(verified.digest, /^[0-9a-f]{64}$/);
    await writeFile(join(directory, 'encoder.wasm'), new Uint8Array([0, 97, 115, 110]));
    await assert.rejects(verifyCodecArtifacts(directory), /artifact hash mismatch/);
  });
});

test('rejects traversal filenames before reading outside artifact directory', async () => {
  const { verifyCodecArtifacts } = await import('../media/codec-artifacts.mjs');
  await fixture(async (directory, manifest) => {
    manifest.artifacts['../outside.wasm'] = manifest.artifacts['encoder.wasm'];
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyCodecArtifacts(directory), /invalid artifact filename/);
  });
});

test('rejects stale OpenH264 metadata and compiler identity mismatch', async () => {
  const { verifyCodecArtifacts } = await import('../media/codec-artifacts.mjs');
  await fixture(async (directory, manifest) => {
    delete manifest.package;
    manifest.source = { emsdk: { version: '4.0.23', commit: 'abc', release: 'def' } };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyCodecArtifacts(directory), /compiler provenance/);
    manifest.wrapperSha256 = '1'.repeat(64);
    manifest.toolchain = { version: '4.0.23', emsdkCommit: 'different', sdkRelease: 'releases-def-64bit' };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verifyCodecArtifacts(directory), /compiler provenance/);
    manifest.toolchain.emsdkCommit = 'abc';
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    assert.equal((await verifyCodecArtifacts(directory)).manifest.toolchain.emsdkCommit, 'abc');
  });
});
