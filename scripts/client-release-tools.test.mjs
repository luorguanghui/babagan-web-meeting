import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { validateRelease, verifyRelease } from './client-release-tools.mjs';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { schema: 1, keyId: 'test-key', spkiBase64: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
const payload = { schema: 1, product: 'babagan-client', platform: 'windows', channel: 'stable', sequence: 2, version: '0.1.1', releasedAt: '2026-11-07T00:00:00Z', minHostProtocol: 1,
  artifact: { url: 'https://meet.babagan.cloud/downloads/clients/windows/0.1.1/client.zip', sha256: 'a'.repeat(64), bytes: 1000 } };
function envelope(value) { const bytes = Buffer.from(JSON.stringify(value)); return { schema: 1, keyId: key.keyId, payloadBase64: bytes.toString('base64'), signatureBase64: sign('RSA-SHA256', bytes, pair.privateKey).toString('base64') }; }
test('signed release round-trips and rejects modified authenticated bytes', () => {
  const signed = envelope(payload); assert.deepEqual(verifyRelease(signed, key), payload);
  assert.throws(() => verifyRelease({ ...signed, payloadBase64: Buffer.from(JSON.stringify({ ...payload, sequence: 3 })).toString('base64') }, key), /signature/);
  assert.throws(() => verifyRelease({ ...signed, keyId: 'untrusted' }, key), /envelope/);
});
test('only the exact versioned artifact for each supported platform may be signed', () => {
  for (const url of ['https://example.test/client.zip','http://meet.babagan.cloud/client.zip','https://meet.babagan.cloud/downloads/clients/windows/../client.zip', payload.artifact.url + '?redirect=1'])
    assert.throws(() => validateRelease({ ...payload, artifact: { ...payload.artifact, url } }), /artifact/);
  assert.throws(() => validateRelease({ ...payload, sequence: 0 }));
  assert.throws(() => validateRelease({ ...payload, platform: 'linux' }));
  assert.throws(() => validateRelease({ ...payload, minHostProtocol: 2 }));
  const android = { ...payload, platform: 'android', artifact: { ...payload.artifact, url: 'https://meet.babagan.cloud/downloads/clients/android/0.1.1/Babagan.apk' } };
  assert.deepEqual(verifyRelease(envelope(android), key), android);
});
