import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { isDiagnosticId, NATIVE_CAPTURE_PROTOCOL } from '@meeting/contracts';
import { type CaptureSession, type CaptureSpawner } from './capture.js';
import { createRecoveringCaptureSession as createCaptureSession, type CaptureDiagnostic } from './capture-recovery.js';
import { CaptureDiagnostics } from './diagnostics.js';
import { FrameSender } from './frame-sender.js';
import { sendControl as send } from './control-sender.js';
import { HttpCaptureError, httpFrameTransport, readHttpControl, readHttpStart, writeHttpError, writeHttpFormat } from './http-stream.js';

export interface NativeCaptureServerOptions {
  ffmpeg?: string;
  origin?: string;
  spawnProcess?: CaptureSpawner;
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  statsIntervalMs?: number;
  getActiveDisplayCount?: () => Promise<number>;
  onDiagnostic?: (event: CaptureDiagnostic) => void;
  onActivity?: (captureActive: boolean) => void;
  parentOwned?: boolean;
}
export interface NativeCaptureServer {
  port: number;
  token: string;
  origin: string;
  launchUrl: string;
  closed: Promise<void>;
  close(): Promise<void>;
}
export function validateOrigin(origin: string): string {
  let parsed: URL;
  try { parsed = new URL(origin); }
  catch { throw new Error('Invalid native capture origin'); }
  const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.origin !== origin || parsed.username || parsed.password || (parsed.protocol !== 'https:' && !localHttp)) {
    throw new Error('Native capture origin must be an exact HTTPS origin or a local HTTP origin');
  }
  return origin;
}

export async function createNativeCaptureServer(options: NativeCaptureServerOptions = {}): Promise<NativeCaptureServer> {
  const origin = validateOrigin(options.origin ?? 'https://meet.babagan.cloud');
  for (const value of [options.startupTimeoutMs, options.idleTimeoutMs, options.statsIntervalMs]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) throw new Error('Invalid native capture timeout');
  }
  const ffmpeg = options.ffmpeg ?? process.env.BABAGAN_FFMPEG ?? 'ffmpeg';
  if (!ffmpeg || ffmpeg.includes('\0')) throw new Error('Invalid FFmpeg executable');
  const token = randomBytes(32).toString('base64url');
  const capability = Buffer.from(`auth.${token}`);
  const bearer = Buffer.from(`Bearer ${token}`);
  const diagnostics = new CaptureDiagnostics();
  const beginDiagnostic = (id: string) => {
    const record = diagnostics.begin(id);
    if (!record) return;
    return (event: CaptureDiagnostic) => {
      record(event);
      try { options.onDiagnostic?.(event); } catch { /* Observer only. */ }
    };
  };
  const http = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const rejectRequest = (status: number, code: string, message: string) => {
      response.once('finish', () => request.destroy());
      writeHttpError(response, status, code, message);
    };
    if (closing || !['/frames-http', '/diagnostics'].includes(request.url ?? '') || request.headers.origin !== origin) {
      rejectRequest(403, 'unauthorized', 'Native capture request is not authorized.'); return;
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
      const headers = (request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map((header) => header.trim()).sort();
      if (request.headers['access-control-request-method'] !== 'POST' || headers.join(',') !== 'authorization,content-type') {
        rejectRequest(403, 'unauthorized', 'Native capture preflight is not allowed.'); return;
      }
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'authorization, content-type',
        'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers', 'Cache-Control': 'no-store' });
      response.end(); return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (request.method !== 'POST' || supplied.length !== bearer.length || !timingSafeEqual(supplied, bearer)) {
      rejectRequest(403, 'unauthorized', 'Native capture request is not authorized.'); return;
    }
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
      rejectRequest(415, 'invalid_control', 'Native capture requires application/json.'); return;
    }
    void (async () => {
      try {
        if (request.url === '/diagnostics') {
          response.setHeader('X-Native-Diagnostics-Version', '1');
          response.setHeader('Access-Control-Expose-Headers', 'X-Native-Diagnostics-Version');
          const control = await readHttpControl(request);
          if (!control || typeof control !== 'object' || Object.keys(control).length !== 1
            || !('diagnosticId' in control) || !isDiagnosticId(control.diagnosticId)) {
            rejectRequest(400, 'invalid_control', 'Expected a diagnostic ID.'); return;
          }
          const snapshot = diagnostics.snapshot(control.diagnosticId);
          if (!snapshot) { rejectRequest(404, 'not_found', 'Diagnostic attempt is unavailable.'); return; }
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          response.end(JSON.stringify(snapshot)); return;
        }
        const { frameRate, diagnosticId } = await readHttpStart(request);
        if (response.destroyed || closing) return;
        if (owner) { rejectRequest(409, 'capture_busy', 'A capture is already active. Stop it before starting another.'); return; }
        const captureId = diagnosticId ?? randomUUID();
        const onDiagnostic = beginDiagnostic(captureId);
        if (!onDiagnostic) { rejectRequest(409, 'invalid_control', 'Diagnostic ID already used.'); return; }
        response.setHeader('X-Native-Diagnostic-Id', captureId);
        response.setHeader('Access-Control-Expose-Headers', 'X-Native-Diagnostic-Id');
        clearTimeout(idleTimer);
        const sender = new FrameSender(httpFrameTransport(response));
        const session = createCaptureSession({ ffmpeg, frameRate, spawnProcess: options.spawnProcess,
          startupTimeoutMs: options.startupTimeoutMs, getActiveDisplayCount: options.getActiveDisplayCount, onDiagnostic,
          onFormat: (format) => writeHttpFormat(response, format), onFrame: (frame) => sender.send(frame),
          onError: (code, message) => writeHttpError(response, code === 'UNSUPPORTED_SOURCE' ? 422 : 502, code, message)
        });
        owner = { connection: response, session, onDiagnostic };
        options.onActivity?.(true);
        response.once('close', () => { onDiagnostic({ event: 'transport_closed', transport: 'http' }); session.stop(); });
        response.once('error', () => { onDiagnostic({ event: 'transport_error', transport: 'http' }); session.stop(); });
        void session.done.then(() => {
          diagnostics.finish(captureId);
          if (!response.destroyed && !response.writableEnded) response.end();
          if (owner?.session === session) { owner = undefined; options.onActivity?.(false); }
          armIdle();
        });
      } catch (error) {
        if (error instanceof HttpCaptureError) rejectRequest(error.status, error.code, error.message);
        else rejectRequest(400, 'invalid_control', 'Invalid native capture request.');
      }
    })();
  });
  http.headersTimeout = 5000;
  http.requestTimeout = 5000;
  http.keepAliveTimeout = 1000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false,
    handleProtocols: () => NATIVE_CAPTURE_PROTOCOL });
  let owner: { connection: WebSocket | ServerResponse; session: CaptureSession; onDiagnostic: (event: CaptureDiagnostic) => void } | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => resolveClosed = resolve);
  const close = async () => {
    if (closing) return closed;
    closing = true;
    clearTimeout(idleTimer);
    const pendingCapture = owner?.session;
    owner?.onDiagnostic({ event: 'helper_shutdown' });
    pendingCapture?.stop();
    http.closeAllConnections();
    for (const client of wss.clients) client.terminate();
    await Promise.all([
      pendingCapture?.done,
      new Promise<void>((resolve) => wss.close(() => resolve())),
      new Promise<void>((resolve) => http.close(() => resolve()))
    ]);
    resolveClosed();
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (!owner && !closing && !options.parentOwned) idleTimer = setTimeout(() => void close(), options.idleTimeoutMs ?? 1_800_000);
  };
  http.on('upgrade', (request, socket, head) => {
    const protocols = (request.headers['sec-websocket-protocol'] ?? '').split(',').map((part) => part.trim());
    const auth = Buffer.from(protocols.find((protocol) => protocol.startsWith('auth.')) ?? '');
    if (closing || request.url !== '/frames' || request.headers.origin !== origin || protocols.length !== 2
      || !protocols.includes(NATIVE_CAPTURE_PROTOCOL) || auth.length !== capability.length || !timingSafeEqual(auth, capability)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (wss.clients.size >= 4) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client));
  });
  wss.on('connection', (socket: WebSocket) => {
    socket.on('error', () => { if (owner?.connection === socket) { owner.onDiagnostic({ event: 'transport_error', transport: 'websocket' }); owner.session.stop(); } });
    socket.on('close', () => { if (owner?.connection === socket) { owner.onDiagnostic({ event: 'transport_closed', transport: 'websocket' }); owner.session.stop(); } });
    socket.on('message', (data, binary) => {
      let message: unknown;
      try { if (binary) throw new Error('Binary control'); message = JSON.parse(data.toString()); }
      catch { send(socket, { type: 'error', code: 'invalid_control', message: 'Expected a small JSON start or stop message.' }); return; }
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        send(socket, { type: 'error', code: 'invalid_control', message: 'Expected a start or stop message.' }); return;
      }
      const control = message as Record<string, unknown>;
      if (control.type === 'stop' && Object.keys(control).length === 1) {
        if (owner?.connection === socket) { owner.onDiagnostic({ event: 'stop_command' }); owner.session.stop(); }
        else send(socket, { type: 'stopped' });
        return;
      }
      if (control.type !== 'start' || ![30, 60].includes(control.frameRate as number) || Object.keys(control).some(key => !['type', 'frameRate', 'diagnosticId'].includes(key))
        || ('diagnosticId' in control && !isDiagnosticId(control.diagnosticId))) {
        send(socket, { type: 'error', code: 'invalid_control', message: 'Start requires frameRate 30 or 60.' }); return;
      }
      if (owner) { send(socket, { type: 'error', code: 'capture_busy', message: 'A capture is already active. Stop it before starting another.' }); return; }
      const captureId = isDiagnosticId(control.diagnosticId) ? control.diagnosticId : randomUUID();
      const onDiagnostic = beginDiagnostic(captureId);
      if (!onDiagnostic) { send(socket, { type: 'error', code: 'invalid_control', message: 'Diagnostic ID already used.' }); return; }
      clearTimeout(idleTimer);
      const sender = new FrameSender(socket);
      const session = createCaptureSession({ ffmpeg, frameRate: control.frameRate as 30 | 60,
        spawnProcess: options.spawnProcess, startupTimeoutMs: options.startupTimeoutMs, getActiveDisplayCount: options.getActiveDisplayCount, onDiagnostic,
        onFormat: (format) => send(socket, format), onFrame: (frame) => sender.send(frame),
        onError: (code, message) => send(socket, { type: 'error', code, message })
      });
      owner = { connection: socket, session, onDiagnostic };
      options.onActivity?.(true);
      const statsTimer = setInterval(() => send(socket, sender.stats()), options.statsIntervalMs ?? 1000);
      void session.done.then(() => {
        diagnostics.finish(captureId);
        clearInterval(statsTimer);
        send(socket, sender.stats());
        send(socket, { type: 'stopped' });
        if (owner?.session === session) { owner = undefined; options.onActivity?.(false); }
        armIdle();
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Unable to bind loopback capture server');
  armIdle();
  return { port: address.port, token, origin, launchUrl: `${origin}/#nativeCapture=1.${address.port}.${token}`, closed, close };
}
