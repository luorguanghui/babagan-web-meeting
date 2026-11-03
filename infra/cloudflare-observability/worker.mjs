export const TARGETS = Object.freeze([
  { name: 'api-live', url: 'https://meet.babagan.cloud/health/live', field: 'status', expected: 'ok' },
  { name: 'api-ready', url: 'https://meet.babagan.cloud/health/ready', field: 'status', expected: 'ready' },
  { name: 'gateway-health', url: 'https://p2p.babagan.cloud/health', field: 'service', expected: 'babagan-p2p' }
]);

const ROUTES = new Set(['health', 'room-create', 'room-join', 'room-ws', 'room-ice', 'room-leave', 'room-end',
  'sfu-session-new', 'sfu-tracks-new', 'sfu-tracks-close', 'sfu-renegotiate', 'sfu-other', 'other']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'OTHER']);
const OUTCOMES = new Set(['ok', 'client_error', 'server_error', 'exception']);

function logEvent(value) {
  const message = value.event === 'gateway_request'
    ? `gateway_request ${value.route} ${value.status}`
    : value.event === 'health_check' ? `health_check ${value.target} ${value.result}`
      : `health_summary ${value.result}`;
  console.log({ ...value, message });
}

async function boundedJson(body, limit) {
  if (!body) throw new Error('empty');
  const reader = body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('oversize');
      chunks.push(value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(joined));
  } finally { await reader.cancel().catch(() => {}); }
}

export function validateEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = ['event', 'route', 'method', 'status', 'durationMs', 'outcome'];
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some(k => !allowed.includes(k))) return null;
  if (value.event !== 'gateway_request' || !ROUTES.has(value.route) || !METHODS.has(value.method) || !OUTCOMES.has(value.outcome)) return null;
  if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599) return null;
  if (!Number.isInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > 3_600_000) return null;
  return { event: 'gateway_request', route: value.route, method: value.method, status: value.status,
    durationMs: value.durationMs, outcome: value.outcome };
}

export async function checkTarget(target, { fetcher = fetch, now = Date.now, timeoutMs = 8000 } = {}) {
  const started = now();
  let status = 0;
  let result = 'network_error';
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetcher(target.url, { method: 'GET', redirect: 'manual',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' }, signal });
    status = response.status;
    if (status !== 200) {
      result = 'http_error';
      await response.body?.cancel();
    } else {
      try {
        const body = await boundedJson(response.body, 4096);
        result = body?.[target.field] === target.expected ? 'ok' : 'invalid_response';
      } catch { result = signal.aborted ? 'timeout' : 'invalid_response'; }
    }
  } catch { result = signal.aborted ? 'timeout' : 'network_error'; }
  return { event: 'health_check', target: target.name, status, result,
    durationMs: Math.max(0, Math.min(3_600_000, Math.round(now() - started))) };
}

export async function runHealth({ fetcher = fetch, log = logEvent, now = Date.now } = {}) {
  const results = await Promise.all(TARGETS.map(target => checkTarget(target, { fetcher, now })));
  for (const result of results) log(result);
  const failures = results.filter(r => r.result !== 'ok').length;
  log({ event: 'health_summary', checks: results.length, failures, result: failures ? 'degraded' : 'ok' });
  return results;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname !== 'diagnostics.internal' || url.pathname !== '/event' || url.search || request.method !== 'POST') {
      return new Response(null, { status: 404 });
    }
    let value;
    try { value = validateEvent(await boundedJson(request.body, 2048)); }
    catch { return new Response(null, { status: 400 }); }
    if (!value) return new Response(null, { status: 400 });
    logEvent(value);
    return new Response(null, { status: 204 });
  },
  async scheduled() { await runHealth(); }
};
