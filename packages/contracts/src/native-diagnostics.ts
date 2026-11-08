/** Diagnostic data is an allowlist, never an Error, track, RTC report or raw log. */
const events = ['starting', 'recovering', 'resumed', 'failed', 'stopped', 'completed',
  'display_check', 'process_started', 'process_exit', 'capture_error', 'first_frame',
  'transport_closed', 'transport_error', 'helper_shutdown', 'stop_command',
  'permission_requested', 'permission_granted', 'permission_denied', 'permission_ended', 'permission_muted', 'permission_unmuted',
  'capture_cancelled', 'native_open', 'native_ready', 'native_error', 'native_closed', 'delivery_failed', 'protocol_error',
  'track_stop', 'track_ended', 'share_stop', 'share_track_ended', 'webrtc_state', 'webrtc_fallback',
  'meeting_state', 'display_observation', 'user_stop', 'leave', 'page_cleanup'] as const;
const codes = ['capture_access_lost', 'capture_recovery_exhausted', 'capture_recovery_timeout', 'capture_stream',
  'capture_timeout', 'capture_launch', 'capture_exit', 'capture_eof', 'UNSUPPORTED_SOURCE', 'unavailable', 'unsupported-source', 'protocol'] as const;
const evidence = ['access_lost', 'device_removed', 'device_reset', 'access_denied', 'output_changed', 'unknown'] as const;
const states = ['new', 'checking', 'connecting', 'connected', 'completed', 'disconnected', 'failed', 'closed', 'reconnecting', 'idle'] as const;
export interface DiagnosticEvent {
  event: typeof events[number];
  code?: typeof codes[number]; evidence?: typeof evidence[number]; state?: typeof states[number];
  stateKind?: 'ice' | 'connection';
  connection?: number;
  transport?: 'p2p' | 'cloudflare' | 'http' | 'websocket';
  signal?: 'SIGTERM' | 'SIGKILL' | 'SIGABRT' | 'SIGSEGV' | 'SIGINT' | null;
  exitCode?: number | null; attempt?: number; displayCount?: number; width?: number; height?: number; dpr?: number;
  hadFrame?: boolean; expectedStop?: boolean;
}
export interface DiagnosticEntry extends DiagnosticEvent { seq: number; elapsedMs: number }
export interface DiagnosticSnapshot { version: 1; id: string; startedAt: string; dropped: number; events: DiagnosticEntry[] }
export function isDiagnosticId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
export function sanitizeDiagnosticEvent(value: unknown): DiagnosticEvent | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  if (!events.includes(input.event as typeof events[number])) return;
  const out: Record<string, unknown> = { event: input.event };
  const enums = { code: codes, evidence, state: states, transport: ['p2p', 'cloudflare', 'http', 'websocket'], stateKind: ['ice', 'connection'],
    signal: ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGINT', null] };
  for (const [key, values] of Object.entries(enums)) if ((values as readonly unknown[]).includes(input[key])) out[key] = input[key];
  for (const key of ['connection', 'exitCode', 'attempt', 'displayCount', 'width', 'height', 'dpr']) {
    const n = input[key];
    if (typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 2 ** 32) out[key] = n;
  }
  if (input.exitCode === null) out.exitCode = null;
  for (const key of ['hadFrame', 'expectedStop']) if (typeof input[key] === 'boolean') out[key] = input[key];
  return out as unknown as DiagnosticEvent;
}
export class DiagnosticTimeline {
  private readonly events: DiagnosticEntry[] = [];
  private seq = 0;
  private readonly start: number;
  private readonly startedAt = new Date().toISOString();
  constructor(readonly id: string, private readonly now: () => number = () => performance.now()) { this.start = now(); }
  record(value: unknown): void {
    const event = sanitizeDiagnosticEvent(value);
    if (!event) return;
    this.events.push({ ...event, seq: this.seq++, elapsedMs: Math.max(0, Math.round(this.now() - this.start)) });
    if (this.events.length > 256) this.events.shift();
  }
  snapshot(): DiagnosticSnapshot {
    return { version: 1, id: this.id, startedAt: this.startedAt, dropped: this.seq - this.events.length, events: this.events.map(e => ({ ...e })) };
  }
}
/** Validate and re-copy even trusted loopback responses at the export boundary. */
export function sanitizeDiagnosticSnapshot(value: unknown, id: string): DiagnosticSnapshot | undefined {
  if (!value || typeof value !== 'object') return;
  const s = value as Record<string, unknown>;
  if (s.version !== 1 || s.id !== id || !isDiagnosticId(id) || typeof s.startedAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s.startedAt)
    || !Array.isArray(s.events) || s.events.length > 256 || !Number.isSafeInteger(s.dropped) || (s.dropped as number) < 0) return;
  const output: DiagnosticEntry[] = [];
  for (const value of s.events) {
    const event = sanitizeDiagnosticEvent(value);
    if (!event || !Number.isSafeInteger(value.seq) || value.seq < 0 || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0) return;
    output.push({ ...event, seq: value.seq, elapsedMs: value.elapsedMs });
  }
  return { version: 1, id, startedAt: s.startedAt, dropped: s.dropped as number, events: output };
}
