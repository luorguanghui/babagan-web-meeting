import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createRecoveringCaptureSession } from './capture-recovery.js';
import type { TimedFrame } from './timestamps.js';

const frame = `process.stderr.write('[Parsed_showinfo_7 @ 1] config in time_base: 1/1000000, frame_rate: 120/1\\n[Parsed_showinfo_7 @ 1] n: 0 pts: 0 pts_time:0 pos:-1\\n'); process.stdout.write('YUV4MPEG2 W4 H2 F120:1 Ip A1:1 C420mpeg2\\nFRAME\\nabcdefghijkl');`;
const lost = `process.stderr.write('AcquireNextFrame failed: 887A0026\\n'); process.exitCode=1;`;
function controlledChild() {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { queueMicrotask(() => this.emit('close', null)); return true; }
  });
  return process as unknown as ChildProcessWithoutNullStreams;
}
function emitFrame(child: ChildProcessWithoutNullStreams) {
  child.stderr.emit('data', Buffer.from('[Parsed_showinfo_7 @ 1] n: 0 pts: 0 pts_time:0 pos:-1\n'));
  child.stdout.emit('data', Buffer.from('YUV4MPEG2 W4 H2 F120:1 Ip A1:1 C420mpeg2\nFRAME\nabcdefghijkl'));
}
it('keeps the authorized session paused beyond the recovery budget until the ordinary desktop returns', async () => {
  vi.useFakeTimers();
  let available = false, completed = false;
  const children: ChildProcessWithoutNullStreams[] = [], frames: TimedFrame[] = [], errors: string[] = [], events: string[] = [];
  const session = createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60,
    getActiveDisplayCount: async () => 1, getDesktopAvailability: async () => available,
    spawnProcess: () => { const child = controlledChild(); children.push(child); return child; },
    onFormat() {}, onFrame: f => frames.push(f), onError: c => errors.push(c), onDiagnostic: e => events.push(e.event) });
  void session.done.then(() => { completed = true; });
  try {
    await vi.advanceTimersByTimeAsync(0);
    emitFrame(children[0]);
    children[0].stderr.emit('data', Buffer.from('AcquireNextFrame failed: 887A0026\n'));
    children[0].emit('close', 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(completed).toBe(false); expect(errors).toEqual([]); expect(children).toHaveLength(1);
    expect(events).toContain('paused');
    available = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(children).toHaveLength(2);
    emitFrame(children[1]);
    expect(events).toContain('resumed');
    expect(frames.map(f => f.index)).toEqual([0, 1]);
    expect(frames[1].captureUs).toBeGreaterThan(frames[0].captureUs);
  } finally { session.stop(); await vi.advanceTimersByTimeAsync(0); await session.done; vi.useRealTimers(); }
});
it('rechecks desktop availability at an exhausted recovery deadline before ending a silent retry', async () => {
  vi.useFakeTimers();
  let available = true, completed = false;
  const children: ChildProcessWithoutNullStreams[] = [], errors: string[] = [], events: string[] = [];
  const session = createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60, recoveryDelayMs: 100,
    getActiveDisplayCount: async () => 1, getDesktopAvailability: async () => available,
    spawnProcess: () => { const child = controlledChild(); children.push(child); return child; },
    onFormat() {}, onFrame() {}, onError: code => errors.push(code), onDiagnostic: event => events.push(event.event) });
  void session.done.then(() => { completed = true; });
  try {
    await vi.advanceTimersByTimeAsync(0); emitFrame(children[0]);
    children[0].stderr.emit('data', Buffer.from('AcquireNextFrame failed: 887A0026\n'));
    await vi.advanceTimersByTimeAsync(9000);
    children[1].stderr.emit('data', Buffer.from('AcquireNextFrame failed: 887A0026\n'));
    await vi.advanceTimersByTimeAsync(100);
    expect(children).toHaveLength(3);
    available = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(completed).toBe(false); expect(errors).toEqual([]); expect(events).toContain('paused');
    expect(children).toHaveLength(3);
    available = true; await vi.advanceTimersByTimeAsync(2000);
    expect(children).toHaveLength(4); emitFrame(children[3]); expect(events).toContain('resumed');
  } finally { session.stop(); await vi.advanceTimersByTimeAsync(0); await session.done; vi.useRealTimers(); }
});

it('rechecks the ordinary desktop before a delayed retry can start a new capture process', async () => {
  vi.useFakeTimers();
  let available = true;
  const children: ChildProcessWithoutNullStreams[] = [], errors: string[] = [], events: string[] = [];
  const session = createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60, recoveryDelayMs: 500,
    getActiveDisplayCount: async () => 1, getDesktopAvailability: async () => available,
    spawnProcess: () => { const child = controlledChild(); children.push(child); return child; },
    onFormat() {}, onFrame() {}, onError: code => errors.push(code), onDiagnostic: event => events.push(event.event) });
  try {
    await vi.advanceTimersByTimeAsync(0); emitFrame(children[0]);
    children[0].stderr.emit('data', Buffer.from('Desktop duplication access denied\n'));
    await vi.advanceTimersByTimeAsync(200); available = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(1); expect(errors).toEqual([]); expect(events).toContain('paused');
  } finally { session.stop(); await vi.advanceTimersByTimeAsync(0); await session.done; vi.useRealTimers(); }
});

it.each(['stop', 'frame'])('ignores a stale deadline probe after %s invalidates recovery', async action => {
  vi.useFakeTimers();
  let answer!: (available: boolean) => void, probes = 0;
  const pending = new Promise<boolean>(resolve => { answer = resolve; });
  const children: ChildProcessWithoutNullStreams[] = [], errors: string[] = [], events: string[] = [];
  const session = createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60, recoveryDelayMs: 100, recoveryTimeoutMs: 1000,
    getActiveDisplayCount: async () => 1, getDesktopAvailability: () => ++probes <= 2 ? Promise.resolve(true) : pending,
    spawnProcess: () => { const child = controlledChild(); children.push(child); return child; },
    onFormat() {}, onFrame() {}, onError: code => errors.push(code), onDiagnostic: event => events.push(event.event) });
  try {
    await vi.advanceTimersByTimeAsync(0); emitFrame(children[0]);
    children[0].stderr.emit('data', Buffer.from('AcquireNextFrame failed: 887A0026\n'));
    await vi.advanceTimersByTimeAsync(1100); expect(probes).toBe(3);
    if (action === 'stop') { session.stop(); await vi.advanceTimersByTimeAsync(0); await session.done; }
    else emitFrame(children[1]);
    answer(false); await vi.advanceTimersByTimeAsync(2000);
    expect(children).toHaveLength(2); expect(errors).toEqual([]); expect(events).not.toContain('paused');
    expect(events).toContain(action === 'stop' ? 'stopped' : 'resumed');
  } finally { answer(true); session.stop(); await vi.advanceTimersByTimeAsync(0); await session.done; vi.useRealTimers(); }
});

it('keeps the recovery deadline bounded while a delayed-start desktop probe is pending', async () => {
  vi.useFakeTimers();
  let answer!: (available: boolean) => void, probes = 0;
  const pending = new Promise<boolean>(resolve => { answer = resolve; });
  const children: ChildProcessWithoutNullStreams[] = [], errors: string[] = [];
  const session = createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60, recoveryDelayMs: 100, recoveryTimeoutMs: 1000,
    getActiveDisplayCount: async () => 1, getDesktopAvailability: () => ++probes === 1 ? Promise.resolve(true) : pending,
    spawnProcess: () => { const child = controlledChild(); children.push(child); return child; },
    onFormat() {}, onFrame() {}, onError: code => errors.push(code) });
  try {
    await vi.advanceTimersByTimeAsync(0); emitFrame(children[0]);
    children[0].stderr.emit('data', Buffer.from('AcquireNextFrame failed: 887A0026\n'));
    await vi.advanceTimersByTimeAsync(1100); answer(true); await vi.advanceTimersByTimeAsync(0); await session.done;
    expect(probes).toBe(2); expect(children).toHaveLength(1); expect(errors).toEqual(['capture_recovery_timeout']);
  } finally { answer(true); session.stop(); await vi.advanceTimersByTimeAsync(0); await session.done; vi.useRealTimers(); }
});
it.each([true, false])('checks an idle VFR capture without mistaking a static ordinary desktop for failure (available=%s)', async available => {
  vi.useFakeTimers();
  const children: ChildProcessWithoutNullStreams[] = [], errors: string[] = [], events: string[] = [];
  const session = createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60,
    getActiveDisplayCount: async () => 1, getDesktopAvailability: async () => available,
    spawnProcess: () => { const child = controlledChild(); children.push(child); return child; },
    onFormat() {}, onFrame() {}, onError: c => errors.push(c), onDiagnostic: e => events.push(e.event) });
  try {
    await vi.advanceTimersByTimeAsync(0); emitFrame(children[0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(1); expect(errors).toEqual([]);
    expect(events.includes('paused')).toBe(!available);
  } finally { session.stop(); await vi.advanceTimersByTimeAsync(0); await session.done; vi.useRealTimers(); }
});

it('cancels a pending desktop probe without resuming capture after revocation', async () => {
  vi.useFakeTimers();
  let answer!: (value: boolean) => void, probes = 0;
  const available = new Promise<boolean>(resolve => { answer = resolve; });
  const children: ChildProcessWithoutNullStreams[] = [], errors: string[] = [];
  const session = createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60,
    getActiveDisplayCount: async () => 1, getDesktopAvailability: () => { probes++; return available; },
    spawnProcess: () => { const child = controlledChild(); children.push(child); return child; },
    onFormat() {}, onFrame() {}, onError: c => errors.push(c) });
  try {
    await vi.advanceTimersByTimeAsync(0); emitFrame(children[0]);
    children[0].stderr.emit('data', Buffer.from('Desktop duplication access denied\n'));
    await vi.advanceTimersByTimeAsync(0);
    expect(probes).toBe(1);
    session.stop(); await session.done;
    answer(true); await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(1); expect(errors).toEqual([]);
  } finally { session.stop(); answer(true); await vi.advanceTimersByTimeAsync(0); await session.done; vi.useRealTimers(); }
});

it('pauses a silent startup only when the ordinary desktop is confirmed unavailable', async () => {
  vi.useFakeTimers();
  let available = false;
  const children: ChildProcessWithoutNullStreams[] = [], errors: string[] = [], events: string[] = [];
  const session = createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60,
    getActiveDisplayCount: async () => 1, getDesktopAvailability: async () => available,
    spawnProcess: () => { const child = controlledChild(); children.push(child); return child; },
    onFormat() {}, onFrame() {}, onError: c => errors.push(c), onDiagnostic: e => events.push(e.event) });
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(1); expect(errors).toEqual([]); expect(events).toContain('paused');
    available = true;
    await vi.advanceTimersByTimeAsync(2000); emitFrame(children[1]);
    expect(events).toContain('resumed'); expect(children).toHaveLength(2);
  } finally { session.stop(); await vi.advanceTimersByTimeAsync(0); await session.done; vi.useRealTimers(); }
});

it.each(['timeout', 'corruption', 'probe-error'])('terminates %s without indefinite capture retries', async scenario => {
  vi.useFakeTimers();
  const children: ChildProcessWithoutNullStreams[] = [], errors: string[] = [];
  const session = createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60,
    getActiveDisplayCount: async () => 1,
    getDesktopAvailability: async () => { if (scenario === 'probe-error') throw new Error('private diagnostic'); return scenario !== 'corruption'; },
    spawnProcess: () => { const child = controlledChild(); children.push(child); return child; },
    onFormat() {}, onFrame() {}, onError: c => errors.push(c) });
  try {
    await vi.advanceTimersByTimeAsync(0);
    if (scenario === 'corruption') children[0].stdout.emit('data', Buffer.from('invalid-stream\n'));
    if (scenario === 'probe-error') children[0].stderr.emit('data', Buffer.from('AcquireNextFrame failed: 887a0026\n'));
    await vi.advanceTimersByTimeAsync(60_000); await session.done;
    expect(errors).toEqual([scenario === 'timeout' ? 'capture_timeout' : scenario === 'corruption' ? 'capture_stream' : 'capture_desktop_check']);
    expect(children).toHaveLength(1);
  } finally { session.stop(); await vi.advanceTimersByTimeAsync(0); await session.done; vi.useRealTimers(); }
});
it.each(['AcquireNextFrame failed: 887A0026', 'Output parameters changed!', 'Desktop duplication access denied'])('keeps one format and continuous sequence across %s', async message => {
  let count = 0, checks = 0;
  const formats: unknown[] = [], frames: TimedFrame[] = [], errors: string[] = [], events: string[] = [];
  const session = createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60, recoveryDelayMs: 1,
    getDesktopAvailability: async () => true,
    getActiveDisplayCount: async () => { checks++; return 1; },
    spawnProcess: () => spawn(process.execPath, ['-e', frame + (count++ === 0 ? `process.stderr.write(${JSON.stringify(message + '\n')});process.exitCode=1;` : '')], { windowsHide: true }),
    onFormat: f => formats.push(f), onFrame: f => frames.push(f), onError: c => errors.push(c), onDiagnostic: e => events.push(e.event) });
  await session.done;
  expect(count).toBe(2); expect(checks).toBe(2); expect(formats).toHaveLength(1);
  expect(frames.map(f => f.index)).toEqual([0, 1]); expect(frames[1].captureUs).toBeGreaterThan(frames[0].captureUs);
  expect(errors).toEqual([]); expect(events).toContain('resumed');
});
it('never retries after stop during the recovery delay', async () => {
  let count = 0; let recovering!: () => void;
  const reached = new Promise<void>(r => { recovering = r; });
  const session = createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60, recoveryDelayMs: 50,
    getDesktopAvailability: async () => true,
    getActiveDisplayCount: async () => 1, spawnProcess: () => { count++; return spawn(process.execPath, ['-e', frame + lost], { windowsHide: true }); },
    onFormat() {}, onFrame() {}, onError() { throw new Error('unexpected fatal error'); }, onDiagnostic: e => { if(e.event === 'recovering') recovering(); } });
  await reached; session.stop(); await session.done;
  await new Promise(r => setTimeout(r, 100)); expect(count).toBe(1);
});
it('bounds repeated access loss and refuses a changed display layout', async () => {
  for (const layoutChanges of [false, true]) {
    let count = 0;
    const errors: string[] = [];
    await createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60, recoveryDelayMs: 1, maxRecoveryAttempts: 2,
      getDesktopAvailability: async () => true,
      getActiveDisplayCount: async () => layoutChanges && count > 0 ? 2 : 1,
      spawnProcess: () => { count++; return spawn(process.execPath, ['-e', frame + lost], { windowsHide: true }); },
      onFormat() {}, onFrame() {}, onError: c => errors.push(c) }).done;
    expect(errors).toEqual([layoutChanges ? 'UNSUPPORTED_SOURCE' : 'capture_recovery_exhausted']);
    expect(count).toBe(layoutChanges ? 1 : 3);
  }
});

it('rechecks the single-monitor policy before any recovered process can start', async () => {
  let spawned = 0, checks = 0;
  const errors: string[] = [], formats: unknown[] = [];
  await createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60, sourcePolicy: 'single-active-monitor', recoveryDelayMs: 1,
    getDesktopAvailability: async () => true,
    getActiveDisplayCount: async () => ++checks === 1 ? 1 : 2,
    spawnProcess: () => { spawned++; return spawn(process.execPath, ['-e', frame + lost], { windowsHide: true }); },
    onFormat: value => formats.push(value), onFrame() {}, onError: code => errors.push(code) }).done;
  expect(formats).toEqual([expect.objectContaining({ source: { kind: 'sole-active-monitor', activeDisplayCount: 1, outputIndex: 0 } })]);
  expect(checks).toBe(2); expect(spawned).toBe(1); expect(errors).toEqual(['UNSUPPORTED_SOURCE']);
});
