/* global URL, console */
// Local benchmark server only; not part of the public meeting application.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import { verifyCodecArtifacts, sha256 } from '../media/codec-artifacts.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const routes = [
  ['/screen-codecs/', resolve(root, 'artifacts/screen-codecs')],
  ['/fixtures/', resolve(root, 'scripts/fixtures')]
];
const verifiedFiles = new Map();
for (const name of ['openh264-2.6.0', 'libav-6.10.9']) {
  const verified = await verifyCodecArtifacts(resolve(root, 'artifacts/screen-codecs', name));
  for (const [path, hash] of verified.files) verifiedFiles.set(path, hash);
}
const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const route = routes.find(([prefix]) => pathname.startsWith(prefix));
  if (!route) { response.writeHead(404).end(); return; }
  const path = resolve(route[1], pathname.slice(route[0].length));
  if (!path.startsWith(route[1] + sep)) { response.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(path);
    if (route[0] === '/screen-codecs/') {
      const expected = verifiedFiles.get(path);
      if (!expected) { response.writeHead(404).end(); return; }
      if (sha256(bytes) !== expected) { response.writeHead(409).end('Codec changed; restart verified benchmark'); return; }
    }
    response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    response.writeHead(200).end(bytes);
  } catch { response.writeHead(404).end(); }
});
server.listen(5190, '127.0.0.1', () => console.log('Codec benchmark: http://127.0.0.1:5190/fixtures/screen-codecs.html'));
