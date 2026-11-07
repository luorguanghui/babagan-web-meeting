import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeCaptureServer, validateOrigin } from './server.js';

export interface CliOptions { ffmpeg: string; origin: string; openBrowser: boolean; edge?: string; idleTimeoutMs: number; help: boolean; statusFile?: string; managed?: boolean }
export function parseCliArgs(args: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = { ffmpeg: env.BABAGAN_FFMPEG ?? 'ffmpeg', origin: 'https://meet.babagan.cloud', openBrowser: true, idleTimeoutMs: 1_800_000, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-open') { options.openBrowser = false; continue; }
    if (arg === '--managed') { options.managed = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!['--ffmpeg', '--origin', '--edge', '--idle-timeout-ms', '--status-file'].includes(arg)) throw new Error('Unknown native capture option. Use --help.');
    const value = args[++i];
    if (!value || value.startsWith('--') || value.includes('\0')) throw new Error('Missing or invalid native capture option value.');
    if (arg === '--ffmpeg') options.ffmpeg = value;
    if (arg === '--origin') options.origin = value;
    if (arg === '--edge') options.edge = value;
    if (arg === '--idle-timeout-ms') options.idleTimeoutMs = Number(value);
    if (arg === '--status-file') options.statusFile = value;
  }
  validateOrigin(options.origin);
  if (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 1 || options.idleTimeoutMs > 2_147_483_647) throw new Error('Invalid idle timeout.');
  if (!options.ffmpeg || options.ffmpeg.includes('\0')) throw new Error('Invalid FFmpeg executable.');
  return options;
}
export function edgeLaunchArguments(profileDirectory: string, launchUrl: string): string[] {
  return [
    `--user-data-dir=${profileDirectory}`,
    '--disable-features=MediaFoundationUseSWBRCForH264Camera,MediaFoundationUseSWBRCForH264Desktop',
    '--enable-features=WebRtcAV1HWEncode',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--no-first-run', '--new-window', launchUrl
  ];
}

/** Edge is the visible application, unlike the console-free capture helper. */
export const edgeSpawnOptions = { windowsHide: false, shell: false, detached: false, stdio: 'ignore' as const };

function findEdge(override?: string): string {
  const candidates = override ? [override] : [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter((directory): directory is string => Boolean(directory)).map((directory) => join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error('Microsoft Edge was not found. Install it or supply --edge with its executable path.');
  return executable;
}

export function assertDdagrabCapabilities(help: string): void {
  if (!/^Filter ddagrab\s*$/m.test(help) || !/^\s+dup_frames\s+<boolean>\s/m.test(help)) {
    throw new Error('FFmpeg ddagrab with the dup_frames option is required to disable duplicate-frame fallback. Supply --ffmpeg or BABAGAN_FFMPEG with a newer build whose "-h filter=ddagrab" lists dup_frames.');
  }
}

async function verifyFfmpeg(executable: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(executable, ['-hide_banner', '-h', 'filter=ddagrab'], { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 256_000 }, (error, stdout) => {
      if (error) { reject(new Error('Unable to inspect FFmpeg ddagrab capabilities. Supply --ffmpeg or set BABAGAN_FFMPEG to a compatible executable.')); return; }
      try { assertDdagrabCapabilities(stdout); resolve(); }
      catch (validationError) { reject(validationError); }
    });
  });
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
