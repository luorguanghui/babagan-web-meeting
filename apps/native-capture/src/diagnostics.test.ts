import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { createNativeCaptureServer } from './server.js';
const id = '00000000-0000-4000-8000-000000000000';
it('exports an authenticated correlated timeline after HTTP failure without secrets or media', async () => {
  const helper = await createNativeCaptureServer({ getActiveDisplayCount: async () => 1,
    spawnProcess: () => spawn(process.execPath, ['-e', "process.stderr.write('secret-token C:/private\\n');process.exitCode=7;"]) });
  const headers = { Origin: helper.origin, Authorization: `Bearer ${helper.token}`, 'Content-Type': 'application/json' };
  const url = `http://127.0.0.1:${helper.port}`;
  try {
    const stream = await fetch(url + '/frames-http', { method: 'POST', headers, body: JSON.stringify({ frameRate: 60, diagnosticId: id }) });
    expect(stream.status).toBe(502); await stream.text();
    const get = (overrides = {}, body = { diagnosticId: id }) => fetch(url + '/diagnostics', { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
    expect((await get({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await get({ Authorization: 'Bearer wrong' })).status).toBe(403);
    expect((await get({}, { diagnosticId: '10000000-0000-4000-8000-000000000000' })).status).toBe(404);
    const response = await get(); expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe(id); expect(data.events).toContainEqual(expect.objectContaining({ event: 'process_exit', exitCode: 7 }));
    expect(JSON.stringify(data)).not.toMatch(/secret-token|private|Bearer/); expect(JSON.stringify(data)).not.toContain(helper.token);
  } finally { await helper.close(); }
});

import { CaptureDiagnostics } from './diagnostics.js';
it('expires and bounds attempts and rejects reuse without erasing old evidence', () => {
  let now = 0; const store = new CaptureDiagnostics(() => now);
  const record = store.begin(id)!; record({ event: 'failed', code: 'capture_exit', secret: 'secret' });
  expect(store.begin(id)).toBeUndefined(); expect(store.snapshot(id)?.events).toHaveLength(1);
  for (let i = 1; i <= 4; i++) {
    const next = `${i}0000000-0000-4000-8000-000000000000`; store.begin(next); store.finish(next);
  }
  expect(store.snapshot(id)).toBeUndefined();
  now = 30 * 60_000 + 1;
  expect(store.snapshot('40000000-0000-4000-8000-000000000000')).toBeUndefined();
});
it('retains quiet active attempts until completion, then expires them', () => {
  let now = 0; const store = new CaptureDiagnostics(() => now); store.begin(id)!({ event: 'starting' });
  now = 31 * 60_000; expect(store.snapshot(id)?.events).toHaveLength(1);
  store.finish(id); now += 31 * 60_000; expect(store.snapshot(id)).toBeUndefined();
});

it.each(['timeout', 'cancel'] as const)('keeps pre-format %s correlated through the advertised capability', async mode => {
  let began!: () => void, stopped!: () => void;
  const ready = new Promise<void>(resolve => { began = resolve; });
  const closed = new Promise<void>(resolve => { stopped = resolve; });
  const helper = await createNativeCaptureServer({ startupTimeoutMs: mode === 'timeout' ? 80 : 2000,
    getActiveDisplayCount: async () => 1, spawnProcess: () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);']),
    onDiagnostic: event => { if (event.event === 'starting') began(); if (event.event === 'stopped') stopped(); } });
  const url = `http://127.0.0.1:${helper.port}`;
  const headers = { Origin: helper.origin, Authorization: `Bearer ${helper.token}`, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ diagnosticId: id });
  try {
    const probe = await fetch(url + '/diagnostics', { method: 'POST', headers, body });
    expect(probe.status).toBe(404); expect(probe.headers.get('X-Native-Diagnostics-Version')).toBe('1'); await probe.text();
    const abort = new AbortController();
    const stream = fetch(url + '/frames-http', { method: 'POST', headers, signal: abort.signal, body: JSON.stringify({ frameRate: 60, diagnosticId: id }) });
    if (mode === 'cancel') {
      const rejected = expect(stream).rejects.toMatchObject({ name: 'AbortError' });
      await ready; abort.abort(); await rejected;
    } else { const response = await stream; expect(response.status).toBe(502); await response.text(); }
    await closed;
    const report = await (await fetch(url + '/diagnostics', { method: 'POST', headers, body })).json();
    expect(report.id).toBe(id);
    expect(report.events.map((e: { event: string }) => e.event)).toContain('stopped');
    if (mode === 'timeout') expect(report.events).toContainEqual(expect.objectContaining({ event: 'failed', code: 'capture_timeout' }));
    else expect(report.events.map((e: { event: string }) => e.event)).not.toContain('recovering');
  } finally { await helper.close(); }
});
