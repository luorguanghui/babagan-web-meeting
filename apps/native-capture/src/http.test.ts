import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { request, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createNativeCaptureServer, type NativeCaptureServer, type NativeCaptureServerOptions } from './server.js';

const servers: NativeCaptureServer[] = [];
const clients: WebSocket[] = [];
const validStream = "process.stderr.write('[Parsed_showinfo_1 @ 1] n:0 pts:0 pts_time:0 pos:-1\\n');process.stdout.write('YUV4MPEG2 W4 H2 F60:1 Ip C420mpeg2\\nFRAME\\nabcdefghijkl');";
afterEach(async () => { clients.splice(0).forEach((client) => client.terminate()); await Promise.all(servers.splice(0).map((server) => server.close())); });
async function helper(options: NativeCaptureServerOptions = {}) {
  const server = await createNativeCaptureServer({ idleTimeoutMs: 10_000, getActiveDisplayCount: async () => 1, ...options });
  servers.push(server); return server;
}
function headers(server: NativeCaptureServer) { return { Origin: server.origin, Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }; }
async function call(server: NativeCaptureServer, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number | undefined; headers: IncomingMessage['headers']; body: Buffer }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.port, path: options.path ?? '/frames-http', method: options.method ?? 'POST', headers: options.headers ?? headers(server) }, (response) => {
      const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    req.on('error', reject); req.end(options.body ?? '{"frameRate":60}');
  });
}
async function startStreaming(server: NativeCaptureServer): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.port, path: '/frames-http', method: 'POST', headers: headers(server) }, resolve);
    req.on('error', reject); req.end('{"frameRate":60}');
  });
}

describe('authenticated HTTP native frame stream', () => {
  it('does not spawn after an attested HTTP request is aborted during display inventory', async () => {
    let resolveCount!: (count: number) => void, checked!: () => void, stopped!: () => void, spawned = false;
    const inventory = new Promise<number>(resolve => { resolveCount = resolve; });
    const reachedInventory = new Promise<void>(resolve => { checked = resolve; });
    const reachedStop = new Promise<void>(resolve => { stopped = resolve; });
    const server = await helper({ getActiveDisplayCount: () => { checked(); return inventory; },
      onActivity: active => { if (!active) stopped(); },
      spawnProcess: () => { spawned = true; throw new Error('Must not capture'); } });
    const req = request({ hostname: '127.0.0.1', port: server.port, path: '/frames-http', method: 'POST', headers: headers(server) });
    req.on('error', () => {}); req.end('{"frameRate":60,"sourcePolicy":"single-active-monitor"}');
    await reachedInventory; req.destroy(); await reachedStop; resolveCount(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(spawned).toBe(false);
  });
  it('attests a single active monitor only after checking it before capture starts', async () => {
    let checked = false, spawned = false;
    const server = await helper({ getActiveDisplayCount: async () => { checked = true; return 1; },
      spawnProcess: () => { expect(checked).toBe(true); spawned = true; return spawn(process.execPath, ['-e', validStream], { windowsHide: true }); } });
    const result = await call(server, { body: '{"frameRate":60,"sourcePolicy":"single-active-monitor"}' });
    expect(result.status).toBe(200); expect(spawned).toBe(true);
    const length = result.body.readUInt32BE(0);
    expect(JSON.parse(result.body.subarray(4, 4 + length).toString()).source)
      .toEqual({ kind: 'sole-active-monitor', activeDisplayCount: 1, outputIndex: 0 });
  });
  it.each([0, 2])('refuses attested capture with %s active monitors before spawning', async count => {
    let spawned = false;
    const server = await helper({ getActiveDisplayCount: async () => count, spawnProcess: () => { spawned = true; throw new Error('Must not capture'); } });
    expect((await call(server, { body: '{"frameRate":60,"sourcePolicy":"single-active-monitor"}' })).status).toBe(422);
    expect(spawned).toBe(false);
  });
  it('does not accept requested source proof or an unknown policy as evidence', async () => {
    let spawned = false;
    const server = await helper({ spawnProcess: () => { spawned = true; throw new Error('Must not capture'); } });
    for (const body of ['{"frameRate":60,"sourcePolicy":"any-monitor"}', '{"frameRate":60,"source":{"activeDisplayCount":1}}',
      '{"frameRate":60,"sourcePolicy":"single-active-monitor","source":{"activeDisplayCount":1}}']) {
      expect((await call(server, { body })).status).toBe(400);
    }
    expect(spawned).toBe(false);
  });
  it('keeps the HTTP owner and headers while paused and cancels recovery on response abort', async () => {
    let paused!: () => void, stopped!: () => void, count = 0;
    const reachedPause = new Promise<void>(resolve => { paused = resolve; });
    const reachedStop = new Promise<void>(resolve => { stopped = resolve; });
    const server = await helper({ getDesktopAvailability: async () => false,
      onDiagnostic: event => { if (event.event === 'paused') paused(); },
      onActivity: active => { if (!active) stopped(); },
      spawnProcess: () => { count++; return spawn(process.execPath, ['-e', validStream
        + "setTimeout(()=>process.stderr.write('Desktop duplication access denied\\n'),100);setInterval(()=>{},1000);"], { windowsHide: true }); } });
    const response = await startStreaming(server); response.resume();
    await reachedPause;
    expect(response.complete).toBe(false); expect(response.statusCode).toBe(200);
    expect((await call(server)).status).toBe(409);
    response.destroy(); await reachedStop;
    expect(count).toBe(1);
  });
  it('keeps the same authorized HTTP stream alive after DXGI access loss without a second metadata header', async () => {
    let count = 0;
    const server = await helper({ getDesktopAvailability: async () => true, spawnProcess: () => spawn(process.execPath, ['-e', validStream +
      (count++ === 0 ? "process.stderr.write('AcquireNextFrame failed: 887a0026\\n');process.exitCode=1;" : '')], { windowsHide: true }) });
    const result = await call(server);
    const offset = 4 + result.body.readUInt32BE(0), packets = result.body.subarray(offset);
    expect(count).toBe(2); expect(packets.length).toBe(56);
    expect(packets.readUInt32BE(4)).toBe(0); expect(packets.readUInt32BE(32)).toBe(1);
    expect(packets.readDoubleBE(36)).toBeGreaterThan(packets.readDoubleBE(8));
  });
  it('allows only the exact POST preflight and never grants wildcard or credential CORS', async () => {
    const server = await helper();
    const preflight = { Origin: server.origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' };
    const valid = await call(server, { method: 'OPTIONS', headers: preflight, body: '' });
    expect(valid.status).toBe(204);
    expect(valid.headers['access-control-allow-origin']).toBe(server.origin);
    expect(valid.headers['access-control-allow-methods']).toBe('POST');
    expect(valid.headers['access-control-allow-headers']).toBe('authorization, content-type');
    expect(valid.headers['access-control-allow-credentials']).toBeUndefined();
    for (const change of [{ Origin: 'https://evil.example' }, { 'Access-Control-Request-Method': 'GET' }, { 'Access-Control-Request-Headers': 'authorization,content-type,x-extra' }]) {
      const invalid = await call(server, { method: 'OPTIONS', headers: { ...preflight, ...change }, body: '' });
      expect(invalid.status).toBe(403);
    }
  });

  it('requires origin and Bearer capability before any capture and rejects query/path aliases', async () => {
    let spawned = false;
    const server = await helper({ spawnProcess: () => { spawned = true; throw new Error('Should not run'); } });
    for (const options of [
      { headers: { ...headers(server), Origin: 'https://evil.example' } },
      { headers: { ...headers(server), Authorization: 'Bearer invalid' } },
      { headers: { Origin: server.origin, 'Content-Type': 'application/json' } },
      { path: `/frames-http?token=${server.token}` }
    ]) expect((await call(server, options)).status).toBe(403);
    expect(spawned).toBe(false);
  });

  it('writes bounded format metadata followed by the existing timestamped I420 packet layout', async () => {
    const server = await helper({ spawnProcess: () => spawn(process.execPath, ['-e', validStream], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) });
    const result = await call(server);
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/octet-stream');
    expect(result.headers['access-control-allow-origin']).toBe(server.origin);
    const length = result.body.readUInt32BE(0);
    expect(length).toBeLessThanOrEqual(4096);
    expect(JSON.parse(result.body.subarray(4, 4 + length).toString())).toEqual({ type: 'format', format: 'I420', width: 4, height: 2, frameRate: 60 });
    const packet = result.body.subarray(4 + length);
    expect(packet.length).toBe(28);
    expect(packet.readUInt32BE(0)).toBe(0x424e4331);
    expect(packet.readUInt32BE(4)).toBe(0);
    expect(Math.abs(packet.readDoubleBE(8) - Date.now() * 1000)).toBeLessThan(1_000_000);
    expect(packet.subarray(16).toString()).toBe('abcdefghijkl');
  });

  it('rejects oversized and invalid JSON before starting a process and remains usable', async () => {
    let spawned = false;
    const server = await helper({ spawnProcess: () => { spawned = true; throw new Error('Should not run'); } });
    for (const body of ['null', '{', '{"frameRate":120}', '{"frameRate":60,"extra":true}', '{}']) {
      expect((await call(server, { body })).status).toBe(400);
    }
    expect((await call(server, { body: 'x'.repeat(1025) })).status).toBe(413);
    expect((await call(server, { headers: { ...headers(server), 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect(spawned).toBe(false);
  });

  it('shares ownership with WebSocket and kills its child on HTTP abort before permitting restart', async () => {
    const children: ChildProcessWithoutNullStreams[] = [];
    const server = await helper({ spawnProcess: () => {
      const child = spawn(process.execPath, ['-e', validStream + 'setInterval(()=>{},1000);'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      children.push(child); return child;
    } });
    const response = await startStreaming(server); response.resume();
    expect(response.statusCode).toBe(200);
    expect((await call(server)).status).toBe(409);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/frames`, ['babagan-native-v1', `auth.${server.token}`], { origin: server.origin }); clients.push(ws);
    await once(ws, 'open');
    const busy = once(ws, 'message'); ws.send('{"type":"start","frameRate":60}');
    expect(JSON.parse((await busy)[0].toString()).code).toBe('capture_busy');
    const closed = once(children[0], 'close'); response.destroy(); await closed;
    const next = await startStreaming(server); next.resume(); expect(next.statusCode).toBe(200);
    expect(children).toHaveLength(2);
    const secondClosed = once(children[1], 'close'); next.destroy(); await secondClosed;
  });

  it('returns a structured failure before headers when display verification or startup fails', async () => {
    const unsupported = await helper({ getActiveDisplayCount: async () => 2 });
    const invalid = await call(unsupported);
    expect(invalid.status).toBe(422);
    expect(JSON.parse(invalid.body.toString()).code).toBe('UNSUPPORTED_SOURCE');
    const stalled = await helper({ startupTimeoutMs: 80, spawnProcess: () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) });
    const timeout = await call(stalled);
    expect(timeout.status).toBe(502);
    expect(JSON.parse(timeout.body.toString()).code).toBe('capture_timeout');
  });

  it('bounds chunked controls even when no Content-Length is supplied', async () => {
    const server = await helper();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.port, path: '/frames-http', method: 'POST', headers: headers(server) }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      req.on('error', reject); req.write('x'.repeat(600)); req.end('x'.repeat(425));
    });
    expect(status).toBe(413);
  });

  it('stops an HTTP owner on helper shutdown without waiting for an open response to drain', async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    const server = await helper({ spawnProcess: () => child = spawn(process.execPath, ['-e', validStream + 'setInterval(()=>{},1000);'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) });
    const response = await startStreaming(server); response.on('error', () => {}); response.resume();
    await server.close();
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  });

  it('cancels a pending display check when HTTP is aborted, without spawning afterward', async () => {
    let completeCheck!: (count: number) => void;
    let beganCheck!: () => void;
    let spawned = false;
    const began = new Promise<void>((resolve) => beganCheck = resolve);
    const check = new Promise<number>((resolve) => completeCheck = resolve);
    const server = await helper({ getActiveDisplayCount: () => { beganCheck(); return check; }, spawnProcess: () => { spawned = true; throw new Error('Should not run'); } });
    const req = request({ hostname: '127.0.0.1', port: server.port, path: '/frames-http', method: 'POST', headers: headers(server) });
    req.on('error', () => {}); req.end('{"frameRate":60}'); await began;
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    completeCheck(1); await server.close();
    expect(spawned).toBe(false);
  });
});
