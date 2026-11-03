import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSfu, secureGateway } from './sfu-gateway.mjs';
const token = 'a'.repeat(64);
const env = { SFU_GATEWAY_TOKEN: token, CALLS_APP_ID: 'test-app', CALLS_APP_TOKEN: 'upstream-private' };
const req = (path, options = {}) => new Request('https://p2p.babagan.cloud/api/sfu'+path, {
  method: 'POST', ...options, headers: { authorization: `Bearer ${token}`, ...options.headers }
});

test('missing/wrong credentials and malformed configuration fail closed before upstream fetch', async () => {
  let calls = 0; const fetcher = async () => { calls++; return Response.json({}); };
  for (const authorization of ['', 'Bearer '+ 'b'.repeat(64), 'Bearer short', 'Basic '+token])
    assert.equal((await handleSfu(req('/sessions/new', { headers: { authorization } }), env, { fetcher })).status, 401);
  assert.equal((await handleSfu(req('/sessions/new'), { ...env, SFU_GATEWAY_TOKEN: '' }, { fetcher })).status, 503);
  assert.equal(calls, 0);
});

test('only fixed SFU paths/methods and server-side requests can reach the selected app', async () => {
  let calls = 0; const fetcher = async () => { calls++; return Response.json({}); };
  for (const path of ['/anything', '/sessions/a%2Fb/tracks/new', '/sessions/new?token=x', '/sessions/a/tracks/new/extra'])
    assert.equal((await handleSfu(req(path), env, { fetcher })).status, 404);
  assert.equal((await handleSfu(req('/sessions/new',{ method:'DELETE' }),env,{fetcher})).status,405);
  assert.equal((await handleSfu(req('/sessions/new',{ headers:{origin:'https://evil.example'} }),env,{fetcher})).status,403);
  assert.equal(calls,0);
});

test('gateway replaces auth, strips caller headers, rejects redirects and preserves SFU response status/body', async () => {
  const input = { force:true, tracks:[{mid:'0'}] };
  const result = await handleSfu(req('/sessions/session/tracks/close', { method:'PUT', headers:{'content-type':'application/json',cookie:'private-cookie'}, body:JSON.stringify(input) }),env,{
    fetcher:async (url, init) => {
      assert.equal(url,'https://rtc.live.cloudflare.com/v1/apps/test-app/sessions/session/tracks/close');
      assert.deepEqual(new Headers(init.headers).get('authorization'),'Bearer upstream-private');
      assert.equal(new Headers(init.headers).has('cookie'),false);
      assert.equal(init.redirect,'error');
      assert.deepEqual(JSON.parse(new TextDecoder().decode(init.body)),input);
      return Response.json({errorCode:'invalid_session_description'},{status:406});
    }
  });
  assert.equal(result.status,406);
  assert.deepEqual(await result.json(),{errorCode:'invalid_session_description'});
  assert.equal(result.headers.has('access-control-allow-origin'),false);
});

test('empty session allocation remains bodyless and resource sizes are bounded',async()=>{
  let calls=0;
  const fetcher=async(_,init)=>{calls++;assert.equal(init.body,undefined);return Response.json({sessionId:'new'},{status:201});};
  assert.equal((await handleSfu(req('/sessions/new'),env,{fetcher})).status,201);
  assert.equal((await handleSfu(req('/sessions/new',{headers:{'content-type':'application/json'},body:'x'.repeat(131073)}),env,{fetcher})).status,413);
  assert.equal(calls,1);
});

test('unrelated health/room requests keep their exact original response',async()=>{
  const response={status:101,webSocket:{}};
  const wrapped=secureGateway({fetch:async()=>response});
  assert.equal(await wrapped.fetch(new Request('https://p2p.babagan.cloud/rooms/room/ws'),env,{}),response);
});
