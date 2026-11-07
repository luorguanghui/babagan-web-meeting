import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { runDesktopHost } from './desktop-host.js';
import type { NativeCaptureServerOptions } from './server.js';

it('uses only the parent pipe for readiness and reports activity until parent EOF', async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', chunk => { text += chunk; });
  let serverOptions: NativeCaptureServerOptions | undefined, close!: () => void;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const run = runDesktopHost([], { input, output, verify: async () => {}, createServer: async options => {
    serverOptions = options;
    return { port: 12345, token: 'capability', origin: 'https://meet.babagan.cloud', launchUrl: 'https://meet.babagan.cloud/#nativeCapture=private',
      closed, close: async () => { close(); } };
  } });
  await vi.waitFor(() => expect(text).toContain('"ready"'));
  expect(serverOptions?.parentOwned).toBe(true);
  serverOptions?.onActivity?.(true); serverOptions?.onActivity?.(false); input.end(); await run;
  expect(text.trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['ready','activity','activity','stopped']);
  expect(text.match(/nativeCapture/g)).toHaveLength(1);
});
it('does not create a helper if the parent closes during executable validation', async () => {
  const input = new PassThrough(), output = new PassThrough(); let verified!: () => void;
  const gate = new Promise<void>(resolve => { verified = resolve; }), createServer = vi.fn();
  const run = runDesktopHost([], { input, output, verify: () => gate, createServer });
  input.end(); await new Promise(resolve => setImmediate(resolve)); verified(); await run;
  expect(createServer).not.toHaveBeenCalled();
});
