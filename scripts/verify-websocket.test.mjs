/* global EventTarget, Event */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRtcWebSocket } from './verify-websocket.mjs';

function factory(events) {
  return class FakeSocket extends EventTarget {
    constructor() {
      super();
      events.push(this);
    }
    close() { this.dispatchEvent(new Event('close')); }
    terminate() {}
  };
}

test('waits for the initial RTC message before closing an open connection', async () => {
  const sockets = [];
  const result = verifyRtcWebSocket('wss://rtc.example.test/rtc', 'header.payload.signature', {
    WebSocketImpl: factory(sockets), timeoutMs: 100
  });
  let settled = false;
  result.finally(() => { settled = true; });
  sockets[0].dispatchEvent(new Event('open'));
  await Promise.resolve();
  assert.equal(settled, false);
  sockets[0].dispatchEvent(new Event('message'));
  assert.match(await result, /initial message/);
});

test('rejects a socket that closes after open without any initial RTC message', async () => {
  const sockets = [];
  const result = verifyRtcWebSocket('wss://rtc.example.test/rtc', 'header.payload.signature', {
    WebSocketImpl: factory(sockets), timeoutMs: 100
  });
  sockets[0].dispatchEvent(new Event('open'));
  sockets[0].dispatchEvent(new Event('close'));
  await assert.rejects(result, /initial message/);
});

test('times out after open when no initial RTC message arrives', async () => {
  const sockets = [];
  const result = verifyRtcWebSocket('wss://rtc.example.test/rtc', 'header.payload.signature', {
    WebSocketImpl: factory(sockets), timeoutMs: 10
  });
  sockets[0].dispatchEvent(new Event('open'));
  await assert.rejects(result, /initial message/);
});
