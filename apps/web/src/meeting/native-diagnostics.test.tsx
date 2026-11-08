import { expect, it, vi } from 'vitest';
import { beginNativeDiagnostics, buildNativeDiagnosticReport, downloadNativeDiagnostics } from './native-diagnostics.js';
const connection = { port: 25191, token: 's'.repeat(43) };
it('exports browser-only information when helper is unavailable, without credentials or raw errors', async () => {
  const session = beginNativeDiagnostics(); session.record({ event: 'permission_ended', message: connection.token });
  session.setHelperId('00000000-0000-4000-8000-000000000000');
  const report = await buildNativeDiagnosticReport(connection, async () => { throw new Error(connection.token); });
  expect(report.helperStatus).toBe('unavailable'); expect(report.browser?.events).toContainEqual(expect.objectContaining({ event: 'permission_ended' }));
  expect(JSON.stringify(report)).not.toContain(connection.token);
});
it('pins export to the selected attempt, sanitizes helper data and rejects a mismatched helper attempt', async () => {
  const session = beginNativeDiagnostics(); const id = '00000000-0000-4000-8000-000000000000'; session.setHelperId(id);
  const request = vi.fn(async () => {
    beginNativeDiagnostics();
    return new Response(JSON.stringify({ version: 1, id, startedAt: '2026-11-07T10:00:00.000Z', dropped: 0,
      events: [{ event: 'process_exit', seq: 0, elapsedMs: 0, exitCode: 9, message: connection.token }], token: connection.token }));
  });
  const report = await buildNativeDiagnosticReport(connection, request);
  expect(report.browser?.id).toBe(session.timeline.id); expect(report.helperStatus).toBe('available');
  expect(report.helper?.events[0].exitCode).toBe(9); expect(JSON.stringify(report)).not.toContain(connection.token);
  const next = beginNativeDiagnostics(); next.setHelperId(id);
  expect((await buildNativeDiagnosticReport(connection, async () => new Response(JSON.stringify({ ...report.helper, id: 'wrong' })))).helperStatus).toBe('invalid');
});
it.each(['x'.repeat(131073), JSON.stringify({ secret: 'private' })])('does not export oversized or malformed helper content', async body => {
  const attempt = beginNativeDiagnostics(); attempt.setHelperId('00000000-0000-4000-8000-000000000000');
  const report = await buildNativeDiagnosticReport(connection, async () => new Response(body));
  expect(report.helper).toBeUndefined(); expect(JSON.stringify(report)).not.toContain('private');
});
it('bounds a stalled helper request and keeps a browser snapshot', async () => {
  vi.useFakeTimers();
  try {
    const attempt = beginNativeDiagnostics(); attempt.setHelperId('00000000-0000-4000-8000-000000000000');
    const pending = buildNativeDiagnosticReport(connection, () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).helperStatus).toBe('unavailable');
  } finally { vi.useRealTimers(); }
});
it('downloads a JSON file only on request and revokes the temporary URL', async () => {
  vi.useFakeTimers();
  const create = vi.fn<(blob: Blob) => string>(() => 'blob:diagnostic'); const revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('babagan-native-diagnostic.json'); expect(this.href).toBe('blob:diagnostic');
  });
  try {
    beginNativeDiagnostics().record({ event: 'permission_ended' });
    expect(create).not.toHaveBeenCalled();
    await downloadNativeDiagnostics(connection);
    expect(click).toHaveBeenCalledOnce(); expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect((create.mock.calls[0][0] as Blob).type).toBe('application/json');
    await vi.advanceTimersByTimeAsync(1000); expect(revoke).toHaveBeenCalledWith('blob:diagnostic');
  } finally { click.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
