import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { buildCaptureArguments, createCaptureSession, type CaptureSpawner } from './capture.js';
import type { TimedFrame } from './timestamps.js';

function fixture(script: string): { spawn: CaptureSpawner; child: () => ChildProcessWithoutNullStreams | undefined } {
  let child: ChildProcessWithoutNullStreams | undefined;
  return {
    spawn: () => child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
    child: () => child
  };
}
const validStream = `process.stderr.write('[Parsed_showinfo_7 @ 1] config in time_base: 1/1000000, frame_rate: 120/1\\n[Parsed_showinfo_7 @ 1] n: 0 pts: 0 pts_time:0 pos:-1\\n'); process.stdout.write('YUV4MPEG2 W4 H2 F120:1 Ip A1:1 C420mpeg2\\nFRAME\\nabcdefghijkl');`;

describe('owned FFmpeg capture session', () => {
  it.each(['rejected', 'unavailable'] as const)('ignores an idle desktop probe that becomes %s after a new frame restores capture', async outcome => {
    vi.useFakeTimers();
    let resolveProbe!: (available: boolean) => void, rejectProbe!: (error: Error) => void;
    const probe = new Promise<boolean>((resolve, reject) => { resolveProbe = resolve; rejectProbe = reject; });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { queueMicrotask(() => this.emit('close', null)); return true; } }) as unknown as ChildProcessWithoutNullStreams;
    const errors: string[] = [], frames: number[] = [];
    const getDesktopAvailability = vi.fn(() => probe);
    const session = createCaptureSession({ ffmpeg: 'unused', frameRate: 60, getActiveDisplayCount: async () => 1,
      getDesktopAvailability, spawnProcess: () => child, onFormat() {}, onFrame: frame => frames.push(frame.index), onError: code => errors.push(code) });
    try {
      await vi.advanceTimersByTimeAsync(0);
      child.stderr.emit('data', Buffer.from('[Parsed_showinfo_7 @ 1] n:0 pts:0 pts_time:0 pos:-1\n'));
      child.stdout.emit('data', Buffer.from('YUV4MPEG2 W4 H2 F120:1 Ip C420mpeg2\nFRAME\nabcdefghijkl'));
      await vi.advanceTimersByTimeAsync(5000); expect(getDesktopAvailability).toHaveBeenCalledOnce();
      child.stderr.emit('data', Buffer.from('[Parsed_showinfo_7 @ 1] n:1 pts:5000000 pts_time:5 pos:-1\n'));
      child.stdout.emit('data', Buffer.from('FRAME\nabcdefghijkl'));
      if (outcome === 'rejected') rejectProbe(new Error('Late OS inventory failure')); else resolveProbe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(frames).toEqual([0, 1]); expect(errors).toEqual([]);
    } finally { session.stop(); resolveProbe(true); await vi.advanceTimersByTimeAsync(0); await session.done; vi.useRealTimers(); }
  });
  it('recognizes a chunked prefixed DXGI error without waiting for a stuck process to exit', async () => {
    const source = fixture(`process.stderr.write('AcquireNextFrame failed: 0x887'); setTimeout(() => process.stderr.write('A0026\\n'), 10); setInterval(()=>{},1000);`);
    const errors: string[] = [];
    await createCaptureSession({ ffmpeg: 'unused', frameRate: 60, startupTimeoutMs: 3000,
      getActiveDisplayCount: async () => 1, spawnProcess: source.spawn,
      onFormat() {}, onFrame() {}, onError: code => errors.push(code) }).done;
    expect(errors).toEqual(['capture_access_lost']);
  });
  it('identifies desktop access loss even when FFmpeg leaves a partial final frame', async () => {
    const source = fixture(validStream + `process.stdout.write('FRAME\\nabc'); process.stderr.write('AcquireNextFrame failed: 887A0026\\n'); process.exitCode=1;`);
    const errors: string[] = [];
    await createCaptureSession({ ffmpeg: 'unused', frameRate: 60, getActiveDisplayCount: async () => 1, spawnProcess: source.spawn,
      onFormat() {}, onFrame() {}, onError: code => errors.push(code) }).done;
    expect(errors).toEqual(['capture_access_lost']);
  });
  it('emits validated metadata and original PTS with pixels from a real subprocess', async () => {
    const source = fixture(validStream);
    const formats: unknown[] = [];
    const frames: TimedFrame[] = [];
    const errors: string[] = [];
    const session = createCaptureSession({ ffmpeg: 'unused', frameRate: 60, getActiveDisplayCount: async () => 1, spawnProcess: source.spawn,
      onFormat: (value) => formats.push(value), onFrame: (value) => frames.push(value), onError: (code) => errors.push(code) });
    await session.done;
    expect(formats).toEqual([{ type: 'format', format: 'I420', width: 4, height: 2, frameRate: 60 }]);
    expect(frames.map(({ frame, index }) => [frame.toString(), index])).toEqual([['abcdefghijkl', 0]]);
    expect(errors).toEqual([]);
  });

  it('stops only its owned capture process promptly', async () => {
    const source = fixture(validStream + 'setInterval(()=>{}, 1000);');
    let frameReady!: () => void;
    const ready = new Promise<void>((resolve) => frameReady = resolve);
    const errors: string[] = [];
    const session = createCaptureSession({ ffmpeg: 'unused', frameRate: 30, getActiveDisplayCount: async () => 1, spawnProcess: source.spawn,
      onFormat() {}, onFrame: () => frameReady(), onError: (code) => errors.push(code) });
    await Promise.race([ready, session.done]);
    session.stop();
    await session.done;
    expect(source.child()).toBeDefined();
    expect(source.child()!.signalCode !== null || source.child()!.exitCode !== null).toBe(true);
    expect(errors).toEqual([]);
  });

  it('kills a stalled startup and reports a bounded error', async () => {
    const source = fixture('setInterval(()=>{}, 1000);');
    const errors: string[] = [];
    const session = createCaptureSession({ ffmpeg: 'unused', frameRate: 60, getActiveDisplayCount: async () => 1, spawnProcess: source.spawn, startupTimeoutMs: 80,
      onFormat() {}, onFrame() {}, onError: (code) => errors.push(code) });
    await session.done;
    expect(errors).toEqual(['capture_timeout']);
    expect(source.child()).toBeDefined();
    expect(source.child()!.signalCode !== null || source.child()!.exitCode !== null).toBe(true);
  });

  it('contains malformed stream and process launch failures', async () => {
    const errors: string[] = [];
    const source = fixture("process.stdout.write('not-y4m\\n'); setInterval(()=>{},1000);");
    await createCaptureSession({ ffmpeg: 'unused', frameRate: 60, getActiveDisplayCount: async () => 1, spawnProcess: source.spawn,
      onFormat() {}, onFrame() {}, onError: (code) => errors.push(code) }).done;
    await createCaptureSession({ ffmpeg: 'invalid', frameRate: 60, getActiveDisplayCount: async () => 1, spawnProcess: () => { throw new Error('private path'); },
      onFormat() {}, onFrame() {}, onError: (code) => errors.push(code) }).done;
    expect(errors).toEqual(['capture_stream', 'capture_launch']);
  });

  it('refuses to choose a desktop when display mapping is ambiguous or inventory fails', async () => {
    for (const getActiveDisplayCount of [async () => 2, async () => 0, async () => { throw new Error('inventory failed'); }]) {
      const source = fixture(validStream);
      const errors: string[] = [];
      await createCaptureSession({ ffmpeg: 'unused', frameRate: 60, getActiveDisplayCount, spawnProcess: source.spawn,
        onFormat() {}, onFrame() {}, onError: (code) => errors.push(code) }).done;
      expect(source.child()).toBeUndefined();
      expect(errors).toEqual(['UNSUPPORTED_SOURCE']);
    }
  });

  it.each([undefined, 'single-active-monitor'] as const)('cancels a pending display check without starting capture afterward (policy: %s)', async sourcePolicy => {
    let resolveCount!: (count: number) => void;
    const count = new Promise<number>((resolve) => resolveCount = resolve);
    const source = fixture(validStream);
    const session = createCaptureSession({ ffmpeg: 'unused', frameRate: 60, sourcePolicy, getActiveDisplayCount: () => count, spawnProcess: source.spawn,
      onFormat() {}, onFrame() {}, onError() {} });
    session.stop();
    resolveCount(1);
    await session.done;
    expect(source.child()).toBeUndefined();
  });

  it('requests DXGI headroom and VFR output without ffmpeg frame duplication', () => {
    const args = buildCaptureArguments(60);
    expect(args[args.indexOf('-i') + 1]).toBe('ddagrab=framerate=120:output_idx=0:draw_mouse=1:dup_frames=0');
    expect(args[args.indexOf('-fps_mode') + 1]).toBe('passthrough');
    expect(args[args.indexOf('-f', args.indexOf('-i')) + 1]).toBe('yuv4mpegpipe');
    const args30 = buildCaptureArguments(30);
    expect(args30[args30.indexOf('-i') + 1]).toBe('ddagrab=framerate=60:output_idx=0:draw_mouse=1:dup_frames=0');
  });
});
