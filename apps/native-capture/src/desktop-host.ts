import type { Readable, Writable } from 'node:stream';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, verifyFfmpeg } from './cli-config.js';
import { createNativeCaptureServer, type NativeCaptureServer } from './server.js';

/** Stdout is a private parent-owned pipe, NOT a log. It carries the capability
 * once. The desktop host must redact it and never persist the ready message. */
export async function runDesktopHost(args: string[], deps: {
  input?: Readable; output?: Writable;
  verify?: typeof verifyFfmpeg; createServer?: typeof createNativeCaptureServer;
} = {}): Promise<void> {
  const options = parseCliArgs([...args, '--no-open']);
  if (options.statusFile || options.edge || options.help) throw new Error('Unsupported desktop-host argument.');
  const input = deps.input ?? process.stdin, output = deps.output ?? process.stdout;
  let helper: NativeCaptureServer | undefined, ended = false, pending = '';
  const stop = () => { ended = true; void helper?.close(); };
  const emit = (value: object) => { if (!output.destroyed) output.write(JSON.stringify({ v: 1, ...value }) + '\n'); };
  const onData = (chunk: Buffer | string) => {
    pending += chunk.toString();
    if (pending.length > 4096) { stop(); return; }
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
      if (line === 'stop') { stop(); continue; }
      try { const message = JSON.parse(line) as { v?: number; type?: string }; if (message.v === 1 && message.type === 'stop') stop(); }
      catch { stop(); }
    }
  };
  input.on('data', onData); input.once('end', stop); input.once('error', stop); output.once('error', stop);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    await (deps.verify ?? verifyFfmpeg)(options.ffmpeg);
    if (ended || input.readableEnded || input.destroyed) return;
    helper = await (deps.createServer ?? createNativeCaptureServer)({ ffmpeg: options.ffmpeg, origin: options.origin, parentOwned: true,
      onActivity: captureActive => emit({ type: 'activity', captureActive }),
      onDiagnostic: event => emit({ type: 'diagnostic', ...event }) });
    if (ended) { await helper.close(); return; }
    emit({ type: 'ready', launchUrl: helper.launchUrl, port: helper.port });
    await helper.closed;
    emit({ type: 'stopped' });
  } finally {
    await helper?.close();
    input.off('data', onData); input.off('end', stop); input.off('error', stop); output.off('error', stop); input.pause();
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDesktopHost(process.argv.slice(2)).catch(() => {
    process.stderr.write('Desktop capture helper could not start. Check the installed runtime.\n'); process.exitCode = 1;
  });
}
