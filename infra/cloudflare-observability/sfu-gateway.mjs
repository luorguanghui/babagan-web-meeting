const encoder = new TextEncoder();
const TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const reply = (errorCode, status) => Response.json({ errorCode }, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

async function equalToken(a, b) {
  const [aa, bb] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', encoder.encode(v))));
  const x = new Uint8Array(aa), y = new Uint8Array(bb); let different = 0;
  for (let i = 0; i < x.length; i++) different |= x[i] ^ y[i];
  return different === 0;
}

async function readBytes(body, limit) {
  if (!body) return new Uint8Array();
  const reader = body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
      if (size > limit) throw new Error('too_large'); chunks.push(item.value); }
    const data = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    return data;
  } finally { void reader.cancel().catch(() => {}); }
}

export function sfuRoute(path) {
  if (path === '/api/sfu/sessions/new') return { method: 'POST', suffix: '/sessions/new' };
  const match = /^\/api\/sfu\/sessions\/([A-Za-z0-9_-]{1,256})(\/(tracks\/(new|close)|renegotiate))?$/.exec(path);
  if (!match) return null;
  return { method: !match[2] ? 'GET' : match[4] === 'new' ? 'POST' : 'PUT', suffix: path.slice('/api/sfu'.length) };
}

export async function handleSfu(request, env, { fetcher = fetch } = {}) {
  const token = env.SFU_GATEWAY_TOKEN;
  if (!TOKEN.test(token ?? '') || !ID.test(env.CALLS_APP_ID ?? '') || !env.CALLS_APP_TOKEN) return reply('gateway_not_configured', 503);
  const supplied = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/)?.[1];
  if (!supplied || !(await equalToken(supplied, token))) return reply('unauthorized', 401);
  if (request.headers.has('origin')) return reply('browser_requests_not_allowed', 403);
  const url = new URL(request.url), route = sfuRoute(url.pathname);
  if (!route || url.search || url.hash) return reply('invalid_route', 404);
  if (request.method !== route.method) return reply('method_not_allowed', 405);
  let bytes;
  try { bytes = await readBytes(request.body, 131072); } catch { return reply('payload_too_large', 413); }
  if (request.method === 'GET' && bytes.length) return reply('invalid_params', 400);
  if (bytes.length) {
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return reply('invalid_content_type', 415);
    try { const body = JSON.parse(new TextDecoder().decode(bytes));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply('invalid_params', 400);
    } catch { return reply('decoding_error', 400); }
  }
  try {
    const response = await fetcher(`https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}${route.suffix}`, {
      method: request.method, redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${env.CALLS_APP_TOKEN}`, ...(bytes.length ? { 'content-type': 'application/json' } : {}) },
      ...(bytes.length ? { body: bytes } : {})
    });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      return reply('gateway_upstream_redirect', 502);
    }
    const body = await readBytes(response.body, 262144);
    return new Response(body.length ? body : null, { status: response.status, headers: {
      'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
    } });
  } catch { return reply('gateway_upstream_unavailable', 502); }
}

export function secureGateway(original) {
  return { ...original, fetch(request, env, ctx) {
    return new URL(request.url).pathname.startsWith('/api/sfu')
      ? handleSfu(request, env) : original.fetch(request, env, ctx);
  } };
}
