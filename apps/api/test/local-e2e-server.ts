/**
 * Local E2E server harness (test-only; never deployed).
 *
 * Boots the real API (`buildApp`) with a fake LiveKit media service and serves
 * the built web app, the API, and the P2P signaling WebSocket on a single
 * origin (`http://127.0.0.1:8080`) so Playwright can drive the complete UI
 * flow locally without a real LiveKit server:
 *
 * - `apps/api/test/fakes/fake-media-service.ts` stands in for LiveKit (token
 *   issuance is pure JWT; room/participant administration and ICE credentials
 *   become no-ops). P2P signaling is entirely DB + in-memory registry based,
 *   so the offer/answer/ICE/media flow runs for real between two Chromium
 *   pages (host-candidate ICE over loopback).
 * - A raw `node:http` server on :8080 serves `apps/web/dist` statically (SPA
 *   fallback to `index.html`) and reverse-proxies `/api/*` and WebSocket
 *   upgrades to the API on :3000, keeping the browser on one origin so the
 *   app's relative `/api/v1` requests and same-origin cookies just work.
 *
 * Started by the Playwright `webServer` config (local mode, i.e. when
 * `E2E_BASE_URL` is unset). Ports: API 127.0.0.1:3000, origin 127.0.0.1:8080.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';


import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import type { IdGenerator } from '../src/services/meeting-service.js';
import { Argon2PasswordHasher } from '../src/security/password-hasher.js';
import { HostApplicationService } from '../src/services/host-application-service.js';
import { KeyedMutex } from '../src/services/keyed-mutex.js';
import { MeetingService } from '../src/services/meeting-service.js';
import { ParticipantApplicationService } from '../src/services/participant-application-service.js';
import { SqliteMeetingRepository } from '../src/repositories/sqlite-meeting-repository.js';
import { FakeMediaService } from './fakes/fake-media-service.js';

const API_PORT = Number(process.env.E2E_API_PORT ?? 3000);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 8080);
const API_HOST = '127.0.0.1';
const WEB_HOST = '127.0.0.1';

/**
 * The API rate-limits admin-password endpoints to 5 requests per 15 minutes
 * per IP. A full E2E run needs several creates + admin-ends, and repeated
 * runs within the window would trip the limiter. Loopback addresses
 * 127.0.0.2+ are bound as the upstream source, so every proxied request is
 * seen by the API as a fresh client IP (rate limiting itself is out of E2E
 * scope; the P2P flow it guards is what these tests exercise).
 */
let sourceIpIndex = 1;
function nextSourceIp(): string {
  sourceIpIndex = (sourceIpIndex % 253) + 1;
  return `127.0.0.${sourceIpIndex + 1}`;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const webDist = join(repoRoot, 'apps', 'web', 'dist');

/** Mirrors the production server's `SecureIds` (not exported there). */
class LocalE2eIds implements IdGenerator {
  uuid(): string { return randomUUID(); }
  slug(): string { return randomBytes(24).toString('base64url'); }
  token(): string { return randomBytes(32).toString('base64url'); }
  participantIdentity(): string { return randomUUID(); }
}

async function main(): Promise<void> {
  const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? 'local-dev-password';
  const databasePath = join(mkdtempSync(join(tmpdir(), 'meeting-e2e-')), 'meetings.sqlite');
  const adminPasswordHash = await new Argon2PasswordHasher().hash(adminPassword);

  const config = loadConfig({
    NODE_ENV: process.env.E2E_NODE_ENV ?? 'test',
    PUBLIC_BASE_URL: `http://${WEB_HOST}:${WEB_PORT}`,
    LIVEKIT_URL: 'wss://127.0.0.1:7880',          // dummy; the fake media service never uses it
    LIVEKIT_INTERNAL_URL: 'ws://127.0.0.1:7880',
    LIVEKIT_API_KEY: 'local-e2e-key',
    LIVEKIT_API_SECRET: 'local-e2e-secret',
    ADMIN_PASSWORD_HASH: adminPasswordHash,
    COOKIE_SECRET: 'local-e2e-cookie-secret-0123456789abcdef',
    DATABASE_PATH: databasePath
  });

  const database = createDatabase(config.databasePath);
  migrate(database);
  const repository = new SqliteMeetingRepository(database);
  const media = new FakeMediaService();
  const clock = { now: () => Date.now() };
  const ids = new LocalE2eIds();
  const mutex = new KeyedMutex();
  const passwords = new Argon2PasswordHasher();
  const meetings = new MeetingService({
    repository,
    media: {
      listParticipantIdentities: async (meetingId) => [...await media.listParticipantIdentities(meetingId)],
      issueParticipantToken: (input) => media.issueToken(input),
      removeParticipant: (meetingId, identity) => media.removeParticipant(meetingId, identity),
      closeMeeting: (meetingId) => media.deleteRoom(meetingId)
    },
    passwords,
    clock,
    ids,
    config,
    mutex
  });
  const hosts = new HostApplicationService({ repository, meetings, media, passwords, clock, ids, config, mutex });
  const participants = new ParticipantApplicationService({ repository, media, clock, ids, config });
  // The webhook route (/internal/livekit/webhook) is not exercised locally.
  const webhooks = { handle: async () => undefined } as unknown as import('../src/livekit/webhook-handler.js').WebhookHandler;

  const app = await buildApp({ config, meetings, hosts, participants, media, webhooks });
  await app.listen({ host: API_HOST, port: API_PORT });
  app.log.info({ databasePath, adminPassword }, 'local E2E API listening');

  const origin = serveOrigin();
  await new Promise<void>((resolveListen) => {
    origin.once('listening', resolveListen);
    origin.listen(WEB_PORT, WEB_HOST);
  });
  console.log(`[local-e2e] origin ready on http://${WEB_HOST}:${WEB_PORT} (admin password: ${adminPassword})`);

  const shutdown = async () => {
    try { await app.close(); } catch { /* already closed */ }
    try { database.close(); } catch { /* already closed */ }
    origin.closeAllConnections?.();
    origin.close();
  };
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
}

/** Serves static web assets and proxies API traffic + WS upgrades to the API. */
function serveOrigin(): ReturnType<typeof createHttpServer> {
  const server = createHttpServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/api/') || url.startsWith('/health/')) {
      proxyToApi(req, res);
      return;
    }
    serveStatic(url, res);
  });

  server.on('upgrade', (req, socket, head) => {
    // Blind TCP pipe: forward the original upgrade request to the API.
    const upstream = netConnect({ host: API_HOST, port: API_PORT, localAddress: nextSourceIp() });
    upstream.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') {
        // Fallback if the OS rejects the rotating loopback address.
        socket.destroy();
        return;
      }
      socket.destroy();
    });
    upstream.on('connect', () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) upstream.write(`${key}: ${value}\r\n`);
      }
      upstream.write('\r\n');
      if (head.length > 0) upstream.write(head);
    });
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  return server;
}

function proxyToApi(req: import('node:http').IncomingMessage, res: ServerResponse): void {
  // Bodyless upstream requests would otherwise be sent with chunked transfer
  // encoding; normalize to Content-Length: 0 so fastify sees the same framing
  // a browser sends. (The web client no longer sends a JSON content type on
  // bodyless requests, and the API maps any FST_ERR_CTP_* rejection to a 400,
  // so the proxy performs no header rewriting beyond this.)
  const hasBody = req.headers['transfer-encoding'] !== undefined
    || (Number(req.headers['content-length'] ?? 0) > 0);
  const headers: Record<string, string | string[] | number> = {
    ...req.headers,
    host: `${API_HOST}:${API_PORT}`
  };
  if (!hasBody) headers['content-length'] = 0;
  const upstream = httpRequest({
    host: API_HOST,
    port: API_PORT,
    path: req.url,
    method: req.method,
    headers,
    localAddress: nextSourceIp()
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRNOTAVAIL') {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: String(error.message) } }));
    }
  });
  if (hasBody) req.pipe(upstream);
  else upstream.end();
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

function serveStatic(urlPath: string, res: ServerResponse): void {
  const pathname = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  let finalPath = resolve(webDist, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  if (!finalPath.startsWith(webDist) || !isFile(finalPath)) {
    // SPA fallback for client routes (/create, /meetings/:slug).
    finalPath = join(webDist, 'index.html');
  }
  try {
    const body = readFileSync(finalPath);
    const isIndex = finalPath === join(webDist, 'index.html');
    res.writeHead(200, {
      'content-type': contentTypes[extname(finalPath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': isIndex ? 'no-store' : 'public, max-age=3600'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'local E2E server failed');
    process.exitCode = 1;
  });
}
