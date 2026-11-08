import { DiagnosticTimeline, isDiagnosticId, sanitizeDiagnosticSnapshot, type DiagnosticSnapshot } from '@meeting/contracts';
import type { NativeCaptureConnection } from './native-capture.js';

export interface NativeDiagnosticAttempt {
  timeline: DiagnosticTimeline;
  helperId?: string;
  record(event: unknown): void;
  nextConnection(): number;
  setHelperId(id: unknown): void;
}
let latest: NativeDiagnosticAttempt | undefined;
const tracks = new WeakMap<MediaStreamTrack, NativeDiagnosticAttempt>();
export function beginNativeDiagnostics(): NativeDiagnosticAttempt {
  const timeline = new DiagnosticTimeline(crypto.randomUUID());
  let connections = 0;
  const attempt: NativeDiagnosticAttempt = { timeline, record: event => timeline.record(event), nextConnection: () => ++connections,
    setHelperId: id => { if (isDiagnosticId(id)) attempt.helperId = id; } };
  latest = attempt;
  return attempt;
}
export function getNativeDiagnosticSnapshot() { return latest?.timeline.snapshot(); }
export function bindNativeDiagnostics(track: MediaStreamTrack, attempt: NativeDiagnosticAttempt) { tracks.set(track, attempt); }
export function nativeTrackDiagnostics(track?: MediaStreamTrack) { return track ? tracks.get(track) : undefined; }

/** Probe without changing old helpers' start payload. Correlate before any frame/header arrives. */
export async function prepareNativeDiagnosticId(connection: NativeCaptureConnection, attempt: NativeDiagnosticAttempt,
  request: typeof fetch, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return;
  const abort = new AbortController();
  let cancel!: () => void;
  const cancelled = new Promise<undefined>(resolve => { cancel = () => { abort.abort(); resolve(undefined); }; });
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 750);
  try {
    const probe = request(`http://127.0.0.1:${connection.port}/diagnostics`, { method: 'POST', mode: 'cors',
      credentials: 'omit', cache: 'no-store', signal: abort.signal,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ diagnosticId: attempt.timeline.id }) }).then(response => {
      const supported = response.status === 404 && response.headers.get('X-Native-Diagnostics-Version') === '1';
      void response.body?.cancel().catch(() => undefined);
      return supported ? attempt.timeline.id : undefined;
    });
    const id = await Promise.race([probe, cancelled]);
    if (id && !signal.aborted) { attempt.setHelperId(id); return id; }
  } catch { /* Old/offline helper: preserve the original capture path. */ }
  finally { clearTimeout(timer); abort.abort(); signal.removeEventListener('abort', cancel); }
}

export interface NativeDiagnosticReport {
  version: 1;
  browser?: DiagnosticSnapshot;
  helper?: DiagnosticSnapshot;
  helperStatus: 'available' | 'unavailable' | 'invalid' | 'not-correlated' | 'no-attempt';
}
async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length') ?? 0) > 131072) {
    await response.body?.cancel(); throw new Error('Invalid diagnostic size');
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > 131072) throw new Error('Invalid diagnostic size');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function buildNativeDiagnosticReport(connection: NativeCaptureConnection, request: typeof fetch = (input, init) => globalThis.fetch(input, init)): Promise<NativeDiagnosticReport> {
  // Pin the attempt before awaiting I/O; a new share cannot replace this export.
  const attempt = latest;
  if (!attempt) return { version: 1, helperStatus: 'no-attempt' };
  const report: NativeDiagnosticReport = { version: 1, browser: attempt.timeline.snapshot(), helperStatus: 'not-correlated' };
  if (!attempt.helperId) return report;
  const id = attempt.helperId;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      const response = await request(`http://127.0.0.1:${connection.port}/diagnostics`, { method: 'POST', mode: 'cors',
        credentials: 'omit', cache: 'no-store', signal: abort.signal,
        headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ diagnosticId: id }) });
      if (!response.ok) { await response.body?.cancel(); return undefined; }
      return { snapshot: sanitizeDiagnosticSnapshot(await readBoundedJson(response), id) };
    };
    const result = await Promise.race([read(), new Promise<undefined>(resolve => {
      timer = setTimeout(() => { abort.abort(); resolve(undefined); }, 2000);
    })]);
    if (result?.snapshot) { report.helper = result.snapshot; report.helperStatus = 'available'; }
    else report.helperStatus = result ? 'invalid' : 'unavailable';
  } catch { report.helperStatus = 'unavailable'; }
  finally { clearTimeout(timer); abort.abort(); }
  return report;
}
export async function downloadNativeDiagnostics(connection: NativeCaptureConnection): Promise<void> {
  const report = await buildNativeDiagnosticReport(connection);
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'babagan-native-diagnostic.json';
  document.body.append(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
