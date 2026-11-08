import type { NativeCaptureFormat } from '@meeting/contracts';
import { createCaptureSession, getWindowsDesktopAvailability, type CaptureOptions, type CaptureSession } from './capture.js';

export interface CaptureDiagnostic { event: 'starting' | 'recovering' | 'paused' | 'resumed' | 'failed' | 'stopped'; code?: string; attempt?: number }
/** Keep the authorized stream alive while its ordinary desktop is unavailable.
 * Only confirmed desktop unavailability suspends the bounded DXGI retry budget.
 * Stop/revocation always cancels retry; every attempt revalidates display mapping.
 */
export function createRecoveringCaptureSession(options: CaptureOptions & {
  recoveryDelayMs?: number; recoveryTimeoutMs?: number; maxRecoveryAttempts?: number; desktopPollMs?: number;
  onDiagnostic?: (event: CaptureDiagnostic) => void;
}): CaptureSession {
  let current: CaptureSession | undefined, stopped = false, finished = false;
  let retry: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0, healthySince = 0, recovering = false, paused = false;
  let remainingMs = options.recoveryTimeoutMs ?? 20_000, deadlineStarted = 0;
  let probeVersion = 0, pendingProbe: Promise<boolean> | undefined;
  let recoveryFailure = { code: 'capture_access_lost', message: 'Desktop capture access changed.' };
  const pausedSessions = new WeakSet<CaptureSession>();
  let format: NativeCaptureFormat | undefined, index = 0, lastTimestamp = 0;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const diagnostic = (event: CaptureDiagnostic) => options.onDiagnostic?.(event);
  const complete = () => {
    if (finished) return;
    finished = true; probeVersion++; clearTimeout(retry); clearTimeout(deadline); finish();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; probeVersion++; clearTimeout(retry); clearTimeout(deadline);
    diagnostic({ event: 'stopped' });
    if (current) { current.stop(); void current.done.then(complete); } else complete();
  };
  const fail = (code: string, message: string) => {
    if (stopped || finished) return;
    diagnostic({ event: 'failed', code }); options.onError(code, message); stop();
  };
  const suspendDeadline = () => {
    if (deadline) remainingMs -= Date.now() - deadlineStarted;
    clearTimeout(deadline); deadline = undefined;
  };
  const readDesktop = async (): Promise<boolean | undefined> => {
    const version = ++probeVersion;
    try {
      // Deadline and retry checks share a bounded OS probe. The newest check
      // owns its result; stop and successful frames invalidate stale results.
      pendingProbe ??= Promise.resolve().then(options.getDesktopAvailability ?? getWindowsDesktopAvailability)
        .finally(() => { pendingProbe = undefined; });
      const available = await pendingProbe;
      return stopped || finished || version !== probeVersion ? undefined : available;
    } catch {
      if (version === probeVersion) fail('capture_desktop_check', 'Unable to verify that the ordinary desktop is available.');
      return undefined;
    }
  };
  const pause = async () => {
    suspendDeadline(); clearTimeout(retry); probeVersion++;
    if (!paused) diagnostic({ event: 'paused', code: 'desktop_unavailable', attempt: attempts });
    paused = true; recovering = true;
    // A verified desktop switch starts a fresh available-desktop time window.
    // The attempt limit is retained, so unrelated failures remain bounded.
    remainingMs = options.recoveryTimeoutMs ?? 20_000;
    const session = current;
    if (session) { pausedSessions.add(session); session.stop(); await session.done; }
    if (stopped || finished) return;
    retry = setTimeout(() => void recover(recoveryFailure), options.desktopPollMs ?? 1000);
  };
  const expire = async () => {
    const available = await readDesktop();
    if (available === undefined) return;
    if (!available) { await pause(); return; }
    fail('capture_recovery_timeout', 'Desktop capture did not recover while the ordinary desktop was available.');
  };
  const startAfterDesktopCheck = async () => {
    const available = await readDesktop();
    if (available === undefined) return;
    if (!available) { await pause(); return; }
    if (deadline && Date.now() - deadlineStarted >= remainingMs) {
      fail('capture_recovery_timeout', 'Desktop capture did not recover while the ordinary desktop was available.'); return;
    }
    attempts++; start();
  };
  const recover = async (failure: { code: string; message: string }) => {
    recoveryFailure = failure;
    const available = await readDesktop();
    if (available === undefined) return;
    if (!available) { await pause(); return; }
    suspendDeadline();
    if (!paused && failure.code !== 'capture_access_lost' && failure.code !== 'capture_desktop_unavailable') {
      fail(failure.code, failure.message); return;
    }
    paused = false; recovering = true;
    if (attempts >= (options.maxRecoveryAttempts ?? 8)) {
      fail('capture_recovery_exhausted', 'Desktop capture did not recover. Stop and share again.'); return;
    }
    if (remainingMs <= 0) {
      fail('capture_recovery_timeout', 'Desktop capture did not recover while the ordinary desktop was available.'); return;
    }
    diagnostic({ event: 'recovering', code: failure.code, attempt: attempts + 1 });
    deadlineStarted = Date.now();
    deadline = setTimeout(() => void expire(), remainingMs);
    retry = setTimeout(() => void startAfterDesktopCheck(), options.recoveryDelayMs ?? Math.min(250 * 2 ** attempts, 2000));
  };
  const start = () => {
    if (stopped || finished) return;
    let failure: { code: string; message: string } | undefined;
    diagnostic({ event: 'starting', attempt: attempts });
    const session = createCaptureSession({ ...options, outputSize: format,
      onFormat(next) {
        if (!format) { format = next; options.onFormat(next); }
        else if (next.width !== format.width || next.height !== format.height) {
          fail('capture_stream', 'Native capture changed the authorized stream format.');
        }
      },
      onFrame(frame) {
        if (stopped) return;
        if (recovering) {
          recovering = false; probeVersion++; clearTimeout(deadline); deadline = undefined; remainingMs = options.recoveryTimeoutMs ?? 20_000;
          diagnostic({ event: 'resumed', attempt: attempts }); healthySince = Date.now();
        }
        if (healthySince && Date.now() - healthySince >= 30_000) attempts = 0;
        lastTimestamp = Math.max(frame.captureUs, lastTimestamp + 1);
        options.onFrame({ ...frame, index: index++, captureUs: lastTimestamp });
      },
      onError(code, message) { failure = { code, message }; }
    });
    current = session;
    void session.done.then(() => {
      if (current === session) current = undefined;
      if (stopped) { complete(); return; }
      if (pausedSessions.has(session)) return;
      if (!failure) { complete(); return; }
      if (!['capture_access_lost', 'capture_desktop_unavailable', 'capture_timeout', 'capture_exit'].includes(failure.code)) {
        fail(failure.code, failure.message); return;
      }
      void recover(failure);
    });
  };
  start();
  return { stop, done };
}
