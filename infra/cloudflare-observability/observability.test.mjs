import test from 'node:test';
import assert from 'node:assert/strict';
import { observeFetch } from './diagnostics.mjs';
import worker, { validateEvent, checkTarget, runHealth, TARGETS } from './worker.mjs';

test('gateway logging cannot include URL tokens, headers, SDP, or session ids', async () => {
  const sent = [];
  const pending = [];
  const response = { status: 502, webSocket: {} };
  const wrapped = observeFetch({ fetch: async () => response }, { random: () => 0, now: () => 100 });
  const request = new Request('https://p2p.babagan.cloud/api/sfu/sessions/private-session/tracks/new?token=private-token', {
    method: 'POST', headers: { authorization: 'Bearer private-auth', cookie: 'private-cookie' }, body: 'private-sdp'
  });
  const actual = await wrapped.fetch(request, { DIAGNOSTICS: { fetch: async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) }); return new Response(null, { status: 204 });
  } } }, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  assert.equal(actual, response);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://diagnostics.internal/event');
  assert.equal(sent[0].body.route, 'sfu-tracks-new');
  assert.ok(!JSON.stringify(sent).includes('private-'));
});

test('normal requests are sampled, failures kept, sink failure does not affect response', async () => {
  let sent = 0;
  const env = { DIAGNOSTICS: { fetch: async () => { sent++; throw new Error('private-error'); } } };
  for (const [status, expected] of [[200, 0], [401, 1], [503, 2]]) {
    const pending = [];
    const response = { status };
    const wrapped = observeFetch({ fetch: async () => response }, { random: () => 0.5 });
    assert.equal(await wrapped.fetch(new Request('https://example.com/'), env, { waitUntil: p => pending.push(p) }), response);
    await Promise.all(pending);
    assert.equal(sent, expected);
  }
});

test('exceptions retain behavior without exporting their message or stack', async () => {
  const original = new Error('private-exception');
  const pending = [], sent = [];
  const wrapped = observeFetch({ fetch: async () => { throw original; } });
  await assert.rejects(wrapped.fetch(new Request('https://example.com/rooms/private-room/ws?token=private-token'), {
    DIAGNOSTICS: { fetch: async (_, options) => { sent.push(options.body); return new Response(null, { status: 204 }); } }
  }, { waitUntil: p => pending.push(p) }), e => e === original);
  await Promise.all(pending);
  assert.equal(JSON.parse(sent[0]).route, 'room-ws');
  assert.ok(!sent[0].includes('private-'));
});

test('sink strictly rejects additional fields and non-enumerated values', () => {
  const valid = { event: 'gateway_request', route: 'other', method: 'GET', status: 200, durationMs: 1, outcome: 'ok' };
  assert.deepEqual(validateEvent(valid), valid);
  for (const bad of [{ ...valid, url: 'secret' }, { ...valid, route: 'secret' }, { ...valid, durationMs: NaN },
    { ...valid, status: 999 }, { ...valid, method: 'secret' }, { ...valid, outcome: 'secret' }]) {
    assert.equal(validateEvent(bad), null);
  }
});

test('sink rejects non-internal paths and oversized or invalid bodies', async () => {
  for (const url of ['https://example.com/event', 'https://diagnostics.internal/event?token=secret', 'https://diagnostics.internal/']) {
    assert.equal((await worker.fetch(new Request(url, { method: 'POST', body: '{}' }))).status, 404);
  }
  for (const body of ['x'.repeat(2049), '{}', '{']) {
    assert.equal((await worker.fetch(new Request('https://diagnostics.internal/event', { method: 'POST', body }))).status, 400);
  }
});

test('health verifies response content and never follows redirects', async () => {
  const variants = [
    [() => Response.json({ status: 'ready' }), 'ok'],
    [() => Response.json({ status: 'ok' }), 'invalid_response'],
    [() => new Response('secret', { status: 503 }), 'http_error'],
    [() => new Response(null, { status: 302, headers: { location: 'https://other.example/' } }), 'http_error'],
    [() => new Response('private-response'.repeat(500)), 'invalid_response'],
    [() => { throw new Error('private-network-error'); }, 'network_error']
  ];
  for (const [response, expected] of variants) {
    const result = await checkTarget(TARGETS[1], { fetcher: async (_, options) => {
      assert.equal(options.redirect, 'manual'); return response();
    } });
    assert.equal(result.result, expected);
    assert.ok(!JSON.stringify(result).includes('private-'));
  }
});

test('health enforces deadline and emits one finite summary per scheduled run', async () => {
  const timeout = await checkTarget(TARGETS[0], { timeoutMs: 5, fetcher: (_, { signal }) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('test deadline failed')), 500);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
  }) });
  assert.equal(timeout.result, 'timeout');
  const logs = [];
  await runHealth({ fetcher: async url => Response.json(url.endsWith('/ready') ? { status: 'ready' }
    : url.endsWith('/live') ? { status: 'ok' } : { service: 'babagan-p2p' }), log: value => logs.push(value) });
  assert.equal(logs.length, 4);
  assert.deepEqual(logs[3], { event: 'health_summary', checks: 3, failures: 0, result: 'ok' });
});
