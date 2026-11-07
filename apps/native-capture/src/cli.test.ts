import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { edgeLaunchArguments, edgeSpawnOptions, parseCliArgs, runCli, assertDdagrabCapabilities } from './cli.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => { await rm(join(directory, 'status.json'), { force: true }); await rmdir(directory); }));
});

async function statusFile() {
  const directory = await mkdtemp(join(tmpdir(), 'babagan-launcher-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'status.json');
}

describe('native capture launcher configuration', () => {
  it('opens Edge as a visible GUI without allocating a detached console', () => {
    expect(edgeSpawnOptions).toMatchObject({ windowsHide: false, detached: false, shell: false, stdio: 'ignore' });
  });
  it('requires a ddagrab build that can disable its own duplicate-frame fallback', () => {
    const legacy = 'Filter ddagrab\n  Grab Windows Desktop images\nddagrab AVOptions:\n  framerate <video_rate> ..FV....... set video frame rate\n';
    expect(() => assertDdagrabCapabilities(legacy)).toThrow(/dup_frames/);
    expect(() => assertDdagrabCapabilities(legacy + '  dup_frames <boolean> ..FV....... duplicate frames (default true)\n')).not.toThrow();
    expect(() => assertDdagrabCapabilities('Unknown filter ddagrab.')).toThrow(/ddagrab/);
  });
  it.skipIf(process.platform !== 'win32' || !process.env.BABAGAN_TEST_LEGACY_FFMPEG)('rejects the legacy executable before readiness with an actionable feature error', async () => {
    const path = await statusFile();
    await expect(runCli(['--status-file', path, '--ffmpeg', process.env.BABAGAN_TEST_LEGACY_FFMPEG!, '--no-open', '--idle-timeout-ms', '100'])).rejects.toThrow(/dup_frames/);
    const status = JSON.parse(await readFile(path, 'utf8'));
    expect(status.state).toBe('error');
    expect(status.message).toMatch(/--ffmpeg.*BABAGAN_FFMPEG/);
  });
  it('resolves explicit executable before environment and PATH while keeping capture opt in', () => {
    expect(parseCliArgs([], {})).toMatchObject({ ffmpeg: 'ffmpeg', origin: 'https://meet.babagan.cloud', openBrowser: true, idleTimeoutMs: 1_800_000 });
    expect(parseCliArgs([], { BABAGAN_FFMPEG: 'C:\\tools\\ffmpeg.exe' }).ffmpeg).toBe('C:\\tools\\ffmpeg.exe');
    expect(parseCliArgs(['--ffmpeg', 'C:\\Program Files\\ffmpeg.exe', '--no-open', '--origin', 'http://127.0.0.1:5173'], { BABAGAN_FFMPEG: 'ignored' }))
      .toMatchObject({ ffmpeg: 'C:\\Program Files\\ffmpeg.exe', openBrowser: false, origin: 'http://127.0.0.1:5173' });
  });
  it.each([['--ffmpeg'], ['--origin', 'https://example.test/path'], ['--origin', 'http://example.test'], ['--unknown'], ['--idle-timeout-ms', '-1'], ['--idle-timeout-ms', 'NaN']])('rejects invalid configuration %s', (...args) => {
    expect(() => parseCliArgs(args, {})).toThrow();
  });
  it('keeps the isolated meeting renderer and pacing timers active while its window is in the background', () => {
    expect(edgeLaunchArguments('C:\\Users\\Example Name\\AppData\\Local\\Babagan\\MeetingEdge', 'https://meet.babagan.cloud/#nativeCapture=1.12345.capability')).toEqual([
      '--user-data-dir=C:\\Users\\Example Name\\AppData\\Local\\Babagan\\MeetingEdge',
      '--disable-features=MediaFoundationUseSWBRCForH264Camera,MediaFoundationUseSWBRCForH264Desktop',
      '--enable-features=WebRtcAV1HWEncode',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--no-first-run', '--new-window', 'https://meet.babagan.cloud/#nativeCapture=1.12345.capability'
    ]);
  });

  it('accepts an explicit launcher status path without exposing a capability', () => {
    expect(parseCliArgs(['--status-file', 'C:\\Temp\\native-status.json'], {})).toMatchObject({ statusFile: 'C:\\Temp\\native-status.json' });
  });

  it.skipIf(process.platform !== 'win32')('records a clear startup failure instead of readiness when FFmpeg validation fails', async () => {
    const path = await statusFile();
    await expect(runCli(['--status-file', path, '--ffmpeg', join(tmpdir(), 'missing-native-ffmpeg.exe'), '--no-open'])).rejects.toThrow(/FFmpeg/);
    const status = JSON.parse(await readFile(path, 'utf8'));
    expect(status).toMatchObject({ version: 1, state: 'error', pid: process.pid });
    expect(status.message).toMatch(/FFmpeg/);
    expect(Object.keys(status).sort()).toEqual(['message', 'pid', 'state', 'version']);
  });

  it.skipIf(process.platform !== 'win32' || !process.env.BABAGAN_TEST_FFMPEG)('reports readiness only after validation and a live loopback listener, with no token or launch URL', async () => {
    const path = await statusFile();
    const messages: unknown[][] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => messages.push(args));
    const running = runCli(['--status-file', path, '--ffmpeg', process.env.BABAGAN_TEST_FFMPEG!, '--no-open', '--idle-timeout-ms', '500']).catch((error: unknown) => error);
    let status: Record<string, unknown> | undefined;
    const deadline = Date.now() + 3000;
    while (!status && Date.now() < deadline) {
      try { status = JSON.parse(await readFile(path, 'utf8')); }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    expect(status).toMatchObject({ version: 1, state: 'ready', pid: process.pid });
    expect(Object.keys(status!).sort()).toEqual(['origin', 'pid', 'port', 'state', 'version']);
    const response = await fetch(`http://127.0.0.1:${status!.port}/`);
    expect(response.status).toBe(403);
    expect(await running).toBeUndefined();
    expect(JSON.stringify(messages)).not.toContain('#nativeCapture');
  });

  it.skipIf(process.platform !== 'win32' || !process.env.BABAGAN_TEST_FFMPEG)('reports an Edge validation failure before declaring the helper ready', async () => {
    const path = await statusFile();
    await expect(runCli(['--status-file', path, '--ffmpeg', process.env.BABAGAN_TEST_FFMPEG!, '--edge', join(tmpdir(), 'missing-native-edge.exe')])).rejects.toThrow(/Edge/);
    const status = JSON.parse(await readFile(path, 'utf8'));
    expect(status.state).toBe('error');
    expect(status.message).toMatch(/Edge/);
  });
});
