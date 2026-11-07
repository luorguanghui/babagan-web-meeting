import type { NativeCaptureFormat } from '@meeting/contracts';
import { createCaptureSession, type CaptureOptions, type CaptureSession } from './capture.js';

export interface CaptureDiagnostic { event: 'starting' | 'recovering' | 'resumed' | 'failed' | 'stopped'; code?: string; attempt?: number }
/** Keep the authorized stream and track alive across a bounded DXGI reset.
 * Stop/revocation always cancels retry; every attempt revalidates display mapping.
 */
export function createRecoveringCaptureSession(options: CaptureOptions & {
  recoveryDelayMs?: number; recoveryTimeoutMs?: number; maxRecoveryAttempts?: number;
  onDiagnostic?: (event: CaptureDiagnostic) => void;
}): CaptureSession {
  let current: CaptureSession | undefined, stopped = false, finished = false;
  let retry: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0, healthySince = 0, recovering = false;
  let format: NativeCaptureFormat | undefined, index = 0, lastTimestamp = 0;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const diagnostic = (event: CaptureDiagnostic) => options.onDiagnostic?.(event);
  const complete = () => {
    if (finished) return;
    finished = true; clearTimeout(retry); clearTimeout(deadline); finish();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; clearTimeout(retry); clearTimeout(deadline);
    diagnostic({ event: 'stopped' });
    if (current) { current.stop(); void current.done.then(complete); } else complete();
  };
  const fail = (code: string, message: string) => {
    if (stopped || finished) return;
    diagnostic({ event: 'failed', code }); options.onError(code, message); stop();
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
          recovering = false; clearTimeout(deadline); deadline = undefined;
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
      if (!failure) { complete(); return; }
      if (failure.code !== 'capture_access_lost') { fail(failure.code, failure.message); return; }
      if (++attempts > (options.maxRecoveryAttempts ?? 8)) {
        fail('capture_recovery_exhausted', 'Desktop capture did not recover. Stop and share again.'); return;
      }
      recovering = true;
      diagnostic({ event: 'recovering', code: failure.code, attempt: attempts });
      deadline ??= setTimeout(() => fail('capture_recovery_timeout', 'Desktop capture could not recover within 20 seconds.'), options.recoveryTimeoutMs ?? 20_000);
      retry = setTimeout(start, options.recoveryDelayMs ?? Math.min(250 * 2 ** (attempts - 1), 2000));
    });
  };
  start();
  return { stop, done };
}
