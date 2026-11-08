import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { createRecoveringCaptureSession } from './capture-recovery.js';
import type { DiagnosticEvent } from '@meeting/contracts';
import type { TimedFrame } from './timestamps.js';

const frame = `process.stderr.write('[Parsed_showinfo_7 @ 1] config in time_base: 1/1000000, frame_rate: 120/1\\n[Parsed_showinfo_7 @ 1] n: 0 pts: 0 pts_time:0 pos:-1\\n'); process.stdout.write('YUV4MPEG2 W4 H2 F120:1 Ip A1:1 C420mpeg2\\nFRAME\\nabcdefghijkl');`;
const lost = `process.stderr.write('AcquireNextFrame failed: 887A0026\\n'); process.exitCode=1;`;
it.each(['AcquireNextFrame failed: 887A0026', 'Output parameters changed!', 'Desktop duplication access denied'])('keeps one format and continuous sequence across %s', async message => {
  let count = 0, checks = 0;
  const formats: unknown[] = [], frames: TimedFrame[] = [], errors: string[] = [], events: string[] = [];
  const session = createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60, recoveryDelayMs: 1,
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
    getActiveDisplayCount: async () => 1, spawnProcess: () => { count++; return spawn(process.execPath, ['-e', frame + lost], { windowsHide: true }); },
    onFormat() {}, onFrame() {}, onError() { throw new Error('unexpected fatal error'); }, onDiagnostic: e => { if(e.event === 'recovering') recovering(); } });
  await reached; session.stop(); await session.done;
  await new Promise(r => setTimeout(r, 100)); expect(count).toBe(1);
});
it('bounds repeated access loss and refuses a changed display layout', async () => {
  for (const layoutChanges of [false, true]) {
    let count = 0;
    const errors: string[] = []; const diagnostics: DiagnosticEvent[] = [];
    await createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60, recoveryDelayMs: 1, maxRecoveryAttempts: 2,
      getActiveDisplayCount: async () => layoutChanges && count > 0 ? 2 : 1,
      spawnProcess: () => { count++; return spawn(process.execPath, ['-e', frame + lost], { windowsHide: true }); },
      onFormat() {}, onFrame() {}, onError: c => errors.push(c), onDiagnostic: e => diagnostics.push(e) }).done;
    expect(errors).toEqual([layoutChanges ? 'UNSUPPORTED_SOURCE' : 'capture_recovery_exhausted']);
    expect(count).toBe(layoutChanges ? 1 : 3);
    expect(diagnostics.filter(e => e.event === 'recovering').map(e => e.attempt)).toEqual(layoutChanges ? [1] : [1, 2]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ event: 'capture_error', evidence: 'access_lost' }));
    expect(diagnostics.findIndex(e => e.event === 'failed')).toBeLessThan(diagnostics.findIndex(e => e.event === 'stopped'));
  }
});

it('records timeout then cleanup, and cancels a pending recovery process', async () => {
  let count = 0;
  const events: string[] = [], errors: string[] = [];
  await createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60, recoveryDelayMs: 1, recoveryTimeoutMs: 100,
    getActiveDisplayCount: async () => 1,
    spawnProcess: () => spawn(process.execPath, ['-e', count++ === 0 ? lost : 'setInterval(()=>{},1000);']),
    onFormat() {}, onFrame() {}, onError: code => errors.push(code), onDiagnostic: e => events.push(e.event) }).done;
  expect(errors).toEqual(['capture_recovery_timeout']); expect(count).toBe(2);
  expect(events.indexOf('failed')).toBeLessThan(events.indexOf('stopped'));
});
it('does not retry an unknown crash, and throwing diagnostic observers cannot break cleanup', async () => {
  let count = 0; const errors: string[] = [];
  await createRecoveringCaptureSession({ ffmpeg: 'unused', frameRate: 60, getActiveDisplayCount: async () => 1,
    spawnProcess: () => { count++; return spawn(process.execPath, ['-e', 'process.exitCode=9;']); },
    onFormat() {}, onFrame() {}, onError: c => errors.push(c), onDiagnostic: () => { throw new Error('observer'); } }).done;
  expect(count).toBe(1); expect(errors).toHaveLength(1); expect(errors[0]).not.toBe('capture_access_lost');
});
