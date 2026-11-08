import { expect, it } from 'vitest';
import { DiagnosticTimeline, sanitizeDiagnosticEvent } from './native-diagnostics.js';

it('copies only allowlisted event fields and never serializes arbitrary strings', () => {
  expect(sanitizeDiagnosticEvent({ event: 'process_exit', exitCode: 7, signal: 'SECRET', message: 'token', token: 'secret', code: 'private-path', hadFrame: true }))
    .toEqual({ event: 'process_exit', exitCode: 7, hadFrame: true });
  expect(sanitizeDiagnosticEvent({ event: 'secret' })).toBeUndefined();
});
it('bounds events, exposes dropped count and makes immutable snapshots with monotonic offsets', () => {
  let now = 100;
  const timeline = new DiagnosticTimeline('00000000-0000-4000-8000-000000000000', () => now);
  for (let i = 0; i < 300; i++) { now++; timeline.record({ event: 'starting', attempt: i }); }
  const snapshot = timeline.snapshot();
  expect(snapshot.events).toHaveLength(256); expect(snapshot.dropped).toBe(44);
  expect(snapshot.events[0]).toMatchObject({ seq: 44, elapsedMs: 45 });
  snapshot.events[0].attempt = 999;
  expect(timeline.snapshot().events[0].attempt).toBe(44);
});
