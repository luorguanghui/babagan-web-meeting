import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, rmdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const launcher = fileURLToPath(new URL('../../../scripts/start-native-meeting.ps1', import.meta.url));
const wrapper = fileURLToPath(new URL('../../../scripts/start-native-meeting.cmd', import.meta.url));
const cachedPowerShell = join(process.env.USERPROFILE ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe');
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(join(directory, 'delay.cjs'), { force: true });
    if (existsSync(join(directory, 'BabaganNativeCapture'))) await rmdir(join(directory, 'BabaganNativeCapture'));
    await rmdir(directory);
  }
});
function launch(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number | string; output: string }>((resolve) => {
    execFile('pwsh', ['-NoLogo', '-NoProfile', '-File', launcher, ...args], { windowsHide: true, timeout: 10_000, maxBuffer: 64_000, env }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, output: stdout + stderr });
    });
  });
}

describe.skipIf(process.platform !== 'win32')('native PowerShell startup handshake', () => {
  it('fails visibly for an invalid FFmpeg executable without claiming readiness', async () => {
    const result = await launch(['-Ffmpeg', join(tmpdir(), 'missing-native-ffmpeg.exe'), '-NoOpen']);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/FFmpeg/);
    expect(result.output).not.toMatch(/Native meeting helper ready/);
    expect(result.output).not.toContain('#nativeCapture');
  });

  it.skipIf(!process.env.BABAGAN_TEST_FFMPEG)('reports ready after a validated no-open launch and removes the status file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babagan-launcher-status-')); directories.push(directory);
    const result = await launch(['-Ffmpeg', process.env.BABAGAN_TEST_FFMPEG!, '-NoOpen', '-IdleTimeoutMs', '500'], { ...process.env, TEMP: directory, TMP: directory });
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/Native meeting helper ready/);
    expect(result.output).not.toContain('#nativeCapture');
    expect(await readdir(join(directory, 'BabaganNativeCapture'))).toEqual([]);
  });

  it('bounds a stalled startup and terminates only its owned helper process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babagan-launcher-delay-')); directories.push(directory);
    const preload = join(directory, 'delay.cjs');
    await writeFile(preload, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);');
    const start = Date.now();
    const result = await launch(['-NoOpen', '-StartupTimeoutSeconds', '1'], { ...process.env, NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"` });
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/timed out/i);
    expect(Date.now() - start).toBeLessThan(4500);
    expect(result.output).not.toMatch(/Native meeting helper ready/);
  });

  it.skipIf(!process.env.BABAGAN_TEST_FFMPEG || !existsSync(cachedPowerShell))('uses the available Codex PowerShell runtime when pwsh is absent from PATH', async () => {
    const result = await new Promise<{ code: number | string; output: string }>((resolve) => {
      execFile('cmd.exe', ['/d', '/c', wrapper, '-Ffmpeg', process.env.BABAGAN_TEST_FFMPEG!, '-NoOpen', '-IdleTimeoutMs', '500'], {
        windowsHide: true, timeout: 10_000, env: { ...process.env, PATH: (process.env.PATH ?? '').split(';').filter((entry) => !/powershell/i.test(entry)).join(';') }
      }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, output: stdout + stderr }));
    });
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/Native meeting helper ready/);
  });
});
