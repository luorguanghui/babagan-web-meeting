import type { IncomingMessage, ServerResponse } from 'node:http';
import { isDiagnosticId, type NativeCaptureFormat } from '@meeting/contracts';
import type { FrameTransport } from './frame-sender.js';

export class HttpCaptureError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function readHttpControl(request: IncomingMessage): Promise<unknown> {
  const body = await new Promise<Buffer>((resolve, reject) => {
    if (Number(request.headers['content-length'] ?? 0) > 1024) {
      reject(new HttpCaptureError(413, 'invalid_control', 'Native capture controls are limited to 1024 bytes.')); return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = () => { request.off('data', onData); request.off('end', onEnd); request.off('error', onError); };
    const onData = (chunk: Buffer) => {
      length += chunk.length;
      if (length > 1024) {
        cleanup(); request.pause(); reject(new HttpCaptureError(413, 'invalid_control', 'Native capture controls are limited to 1024 bytes.')); return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, length)); };
    const onError = () => { cleanup(); reject(new HttpCaptureError(400, 'invalid_control', 'Native capture request was interrupted.')); };
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError);
  });
  let control: unknown;
  try { control = JSON.parse(body.toString('utf8')); }
  catch { throw new HttpCaptureError(400, 'invalid_control', 'Expected a JSON frameRate of 30 or 60.'); }
  return control;
}
export async function readHttpStart(request: IncomingMessage): Promise<{ frameRate: 30 | 60; diagnosticId?: string }> {
  const control = await readHttpControl(request);
  if (typeof control !== 'object' || control === null || Array.isArray(control) || Object.keys(control).some(key => !['frameRate', 'diagnosticId'].includes(key))
    || ('diagnosticId' in control && !isDiagnosticId(control.diagnosticId))
    || !('frameRate' in control) || (control.frameRate !== 30 && control.frameRate !== 60)) {
    throw new HttpCaptureError(400, 'invalid_control', 'Expected a JSON frameRate of 30 or 60.');
  }
  return { frameRate: control.frameRate, ...('diagnosticId' in control ? { diagnosticId: control.diagnosticId as string } : {}) };
}

export function writeHttpError(response: ServerResponse, status: number, code: string, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ type: 'error', code, message }));
}

export function writeHttpFormat(response: ServerResponse, format: NativeCaptureFormat): void {
  const json = Buffer.from(JSON.stringify(format));
  if (json.length > 4096) throw new Error('Native format metadata exceeds limit');
  const length = Buffer.allocUnsafe(4); length.writeUInt32BE(json.length);
  response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.cork(); response.write(length); response.write(json); response.uncork();
}

export function httpFrameTransport(response: ServerResponse): FrameTransport {
  return {
    get readyState() { return response.destroyed || response.writableEnded ? 3 : 1; },
    get bufferedAmount() { return response.writableLength; },
    send(data, options, callback) {
      if (!options.fin) { response.cork(); response.write(data); }
      else {
        try { response.write(data, (error) => callback?.(error ?? undefined)); }
        finally { response.uncork(); }
      }
    }
  };
}
