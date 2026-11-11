import { execFile } from 'node:child_process';
import { validateOrigin } from './server.js';

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

/** Keep visible Edge outside the helper's Windows job so idle shutdown cannot close it. */
export const edgeSpawnOptions = { windowsHide: false, shell: false, detached: true, stdio: 'ignore' as const };

export function assertDdagrabCapabilities(help: string): void {
  if (!/^Filter ddagrab\s*$/m.test(help) || !/^\s+dup_frames\s+<boolean>\s/m.test(help)) {
    throw new Error('FFmpeg ddagrab with the dup_frames option is required to disable duplicate-frame fallback. Supply --ffmpeg or BABAGAN_FFMPEG with a newer build whose "-h filter=ddagrab" lists dup_frames.');
  }
}

export async function verifyFfmpeg(executable: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(executable, ['-hide_banner', '-h', 'filter=ddagrab'], { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 256_000 }, (error, stdout) => {
      if (error) { reject(new Error('Unable to inspect FFmpeg ddagrab capabilities. Supply --ffmpeg or set BABAGAN_FFMPEG to a compatible executable.')); return; }
      try { assertDdagrabCapabilities(stdout); resolve(); }
      catch (validationError) { reject(validationError); }
    });
  });
}
