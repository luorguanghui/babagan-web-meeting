/* global URL, console */
// Local benchmark server only; not part of the public meeting application.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const routes = [
  ['/screen-codecs/', resolve(root, 'artifacts/screen-codecs')],
  ['/libav/', resolve(root, 'apps/web/node_modules/@libav.js/variant-vp8-opus/dist')],
  ['/fixtures/', resolve(root, 'scripts/fixtures')]
];
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
    response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    response.writeHead(200).end(bytes);
  } catch { response.writeHead(404).end(); }
});
server.listen(5190, '127.0.0.1', () => console.log('Codec benchmark: http://127.0.0.1:5190/fixtures/screen-codecs.html'));
