import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeCaptureServer } from './server.js';
import { parseCliArgs, verifyFfmpeg, edgeLaunchArguments, edgeSpawnOptions } from './cli-config.js';
export { parseCliArgs, verifyFfmpeg, edgeLaunchArguments, edgeSpawnOptions, assertDdagrabCapabilities, type CliOptions } from './cli-config.js';

function findEdge(override?: string): string {
  const candidates = override ? [override] : [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter((directory): directory is string => Boolean(directory)).map((directory) => join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error('Microsoft Edge was not found. Install it or supply --edge with its executable path.');
  return executable;
}

async function writeStartupStatus(path: string, status: object): Promise<void> {
  try { await writeFile(path, JSON.stringify(status), { encoding: 'utf8', flag: 'wx' }); }
  catch { throw new Error('Unable to write launcher startup status. Check the temporary folder permissions.'); }
}

export async function runCli(args: string[]): Promise<void> {
  const statusIndex = args.lastIndexOf('--status-file');
  const statusPath = statusIndex < 0 ? undefined : args[statusIndex + 1];
  let reportedReady = false;
  try {
    const options = parseCliArgs(args);
    if (options.help) {
      console.log('Babagan native capture (Windows, one active display)\n' +
        '  --ffmpeg <executable>   FFmpeg with ddagrab dup_frames support (default BABAGAN_FFMPEG or PATH)\n' +
        '  --edge <executable>     Optional installed Edge executable\n' +
        '  --origin <origin>       Exact allowed HTTPS origin; localhost HTTP for development\n' +
        '  --no-open               Start helper without launching Edge\n' +
        '  --idle-timeout-ms <ms>   Exit after idle time (default 1800000)\n' +
        '  --status-file <path>    One-time, token-free launcher startup status');
      return;
    }
    if (process.platform !== 'win32') throw new Error('Native DXGI capture requires Windows.');
    await verifyFfmpeg(options.ffmpeg);
    const edge = options.openBrowser ? findEdge(options.edge) : undefined;
    if (edge && !process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required for the isolated meeting profile.');
    const helper = await createNativeCaptureServer({ ffmpeg: options.ffmpeg, origin: options.origin, idleTimeoutMs: options.idleTimeoutMs,
      onDiagnostic: event => { if (options.managed) console.log(JSON.stringify({ time: new Date().toISOString(), ...event })); } });
    const shutdown = () => { void helper.close(); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    const openBrowser = async () => {
      if (edge) {
        const profile = join(process.env.LOCALAPPDATA!, 'Babagan', 'MeetingEdge');
        await new Promise<void>((resolve, reject) => {
          const child = spawn(edge, edgeLaunchArguments(profile, helper.launchUrl), edgeSpawnOptions);
          child.once('error', () => reject(new Error('Unable to open the isolated meeting Edge window.')));
          child.once('spawn', () => { child.unref(); resolve(); });
        });
      }
    };
    let input = '';
    const onInput = (chunk: Buffer) => {
      input += chunk.toString('utf8');
      if (input.length > 1024) { shutdown(); return; }
      let newline: number;
      while ((newline = input.indexOf('\n')) >= 0) {
        const command = input.slice(0, newline).trim(); input = input.slice(newline + 1);
        if (command === 'open') void openBrowser().catch(() => console.log(JSON.stringify({ event: 'open_failed' })));
        else if (command === 'stop') shutdown();
      }
    };
    if (options.managed) {
      process.stdin.on('data', onInput); process.stdin.once('end', shutdown); process.stdin.once('error', shutdown);
    }
    try {
      await openBrowser();
      if (options.statusFile) await writeStartupStatus(options.statusFile, { version: 1, state: 'ready', pid: process.pid, port: helper.port, origin: helper.origin });
      reportedReady = true;
      if (!options.statusFile) console.log(`Native capture helper ready on 127.0.0.1:${helper.port}. Capture starts only after an explicit screen-share action.`);
      await helper.closed;
    } finally {
      await helper.close();
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      if (options.managed) {
        process.stdin.off('data', onInput); process.stdin.off('end', shutdown); process.stdin.off('error', shutdown); process.stdin.pause();
      }
    }
  } catch (error) {
    if (!reportedReady && statusPath && !statusPath.startsWith('--') && !statusPath.includes('\0')) {
      await writeStartupStatus(statusPath, { version: 1, state: 'error', pid: process.pid,
        message: error instanceof Error ? error.message : 'Unable to start native capture helper.' }).catch(() => {});
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  void runCli(args).catch((error: unknown) => {
    if (!args.includes('--status-file')) console.error(error instanceof Error ? error.message : 'Unable to start native capture helper.');
    process.exitCode = 1;
  });
}
