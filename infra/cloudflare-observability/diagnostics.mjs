// Never send URLs, headers, bodies, exception text, or meeting identifiers.
export function routeCategory(path) {
  if (path === '/health') return 'health';
  if (path === '/rooms') return 'room-create';
  const room = /^\/rooms\/[^/]+\/(join|ws|ice|leave|end)$/.exec(path);
  if (room) return `room-${room[1]}`;
  if (/^\/api\/sfu\/sessions\/new$/.test(path)) return 'sfu-session-new';
  if (/^\/api\/sfu\/sessions\/[^/]+\/tracks\/new$/.test(path)) return 'sfu-tracks-new';
  if (/^\/api\/sfu\/sessions\/[^/]+\/tracks\/close$/.test(path)) return 'sfu-tracks-close';
  if (/^\/api\/sfu\/sessions\/[^/]+\/renegotiate$/.test(path)) return 'sfu-renegotiate';
  if (path.startsWith('/api/sfu/')) return 'sfu-other';
  return 'other';
}

export function observeFetch(handler, { random = Math.random, now = Date.now } = {}) {
  return {
    ...handler,
    async fetch(request, env, ctx) {
      const started = now();
      const category = routeCategory(new URL(request.url).pathname);
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(request.method)
        ? request.method : 'OTHER';
      const record = (status, outcome) => {
        // Errors and slow operations are kept; normal traffic is sampled at 1%.
        const durationMs = Math.max(0, Math.min(3_600_000, Math.round(now() - started)));
        if (status < 400 && durationMs < 2000 && random() >= 0.01) return;
        if (!env.DIAGNOSTICS || !ctx?.waitUntil) return;
        const event = { event: 'gateway_request', route: category, method, status, durationMs, outcome };
        // The sink's request metadata contains only this fixed internal URL.
        // Original-request observability stays off to exclude query/path secrets.
        const send = async () => {
          try {
            const result = await env.DIAGNOSTICS.fetch('https://diagnostics.internal/event', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(event), signal: AbortSignal.timeout(2000)
            });
            await result.body?.cancel();
          } catch { /* Diagnostics must never affect a meeting or log raw errors. */ }
        };
        try { ctx.waitUntil(send()); } catch { /* Preserve the original response. */ }
      };
      try {
        const response = await handler.fetch(request, env, ctx);
        record(response.status, response.status >= 500 ? 'server_error' : response.status >= 400 ? 'client_error' : 'ok');
        return response; // Includes the original WebSocket upgrade without cloning.
      } catch (error) {
        record(500, 'exception');
        throw error;
      }
    }
  };
}
