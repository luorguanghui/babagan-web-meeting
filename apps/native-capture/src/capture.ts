import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { sanitizeDiagnosticEvent, type DiagnosticEvent, type NativeCaptureFormat } from '@meeting/contracts';
import { FrameClock, type TimedFrame } from './timestamps.js';
import { Y4mParser } from './y4m.js';

export type CaptureSpawner = (executable: string, args: string[]) => ChildProcessWithoutNullStreams;
export interface CaptureOptions {
  ffmpeg: string;
  frameRate: 30 | 60;
  spawnProcess?: CaptureSpawner;
  startupTimeoutMs?: number;
  getActiveDisplayCount?: () => Promise<number>;
  outputSize?: { width: number; height: number };
  onDiagnostic?: (event: DiagnosticEvent) => void;
  onFormat(format: NativeCaptureFormat): void;
  onFrame(frame: TimedFrame): void;
  onError(code: string, message: string): void;
}
export interface CaptureSession { stop(): void; done: Promise<void> }

export async function getActiveWindowsDisplayCount(): Promise<number> {
  if (process.platform !== 'win32') return 0;
  return new Promise<number>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens.Count'],
    { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
      if (error || !/^\s*\d+\s*$/.test(stdout)) reject(new Error('Unable to verify active displays'));
      else resolve(Number(stdout.trim()));
    });
  });
}
export function buildCaptureArguments(frameRate: 30 | 60, outputSize?: { width: number; height: number }): string[] {
  const scale = 'min(1,min(1080/min(iw,ih),sqrt(8294400/(iw*ih))))';
  const selection = `isnan(prev_selected_t)+gt(floor((t-start_t)*${frameRate}+0.000001),floor((prev_selected_t-start_t)*${frameRate}+0.000001))`;
  const resize = outputSize
    ? `scale=${outputSize.width}:${outputSize.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear:out_color_matrix=bt709:out_range=tv,pad=${outputSize.width}:${outputSize.height}:(ow-iw)/2:(oh-ih)/2`
    : `scale=w='trunc(iw*${scale}/2)*2':h='trunc(ih*${scale}/2)*2':flags=fast_bilinear:out_color_matrix=bt709:out_range=tv`;
  return [
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-filter_threads', '2',
    '-f', 'lavfi', '-i', `ddagrab=framerate=${frameRate * 2}:output_idx=0:draw_mouse=1:dup_frames=0`,
    // Select actual input samples at the target cadence, including static content; never synthesize CFR/fps frames.
    '-vf', `hwdownload,format=bgra,${resize},format=yuv420p,select='${selection}',showinfo=checksum=0`,
    '-an', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-fps_mode', 'passthrough',
    '-f', 'yuv4mpegpipe', 'pipe:1'
  ];
}

export function createCaptureSession(options: CaptureOptions): CaptureSession {
  let child: ChildProcessWithoutNullStreams | undefined;
  let stopped = false;
  let finished = false;
  let hadFrame = false;
  let stderrTail = '';
  let accessLost = false;
  let evidence: DiagnosticEvent['evidence'] = 'unknown';
  let requestedStop = false;
  const diagnostic = (value: unknown) => {
    const event = sanitizeDiagnosticEvent(value);
    try { if (event) options.onDiagnostic?.(event); } catch { /* Diagnostics cannot interrupt capture. */ }
  };
  let killDeadline: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => resolveDone = resolve);
  const complete = () => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    clearTimeout(killDeadline);
    resolveDone();
  };
  const stop = (requested = true) => {
    requestedStop ||= requested;
    if (stopped || finished) return;
    stopped = true;
    clearTimeout(deadline);
    if (!child) { complete(); return; }
    child.kill();
    killDeadline = setTimeout(() => child?.kill('SIGKILL'), 1500);
    killDeadline.unref();
  };
  const fail = (code: string, message: string) => {
    if (stopped || finished) return;
    diagnostic({ event: 'capture_error', code, evidence });
    options.onError(code, message);
    stop(false);
  };
  const clock = new FrameClock((frame) => {
    if (stopped) return;
    if (!hadFrame) diagnostic({ event: 'first_frame' });
    hadFrame = true;
    clearTimeout(deadline);
    options.onFrame(frame);
  });
  const parser = new Y4mParser({
    onFormat: ({ width, height }) => options.onFormat({ type: 'format', format: 'I420', width, height, frameRate: options.frameRate }),
    onFrame: (frame, index) => clock.pushFrame(frame, index)
  });
  const deadline = setTimeout(() => fail('capture_timeout', 'Native capture did not produce a frame before its startup deadline.'), options.startupTimeoutMs ?? 15_000);
  void (async () => {
    try {
      const count = await (options.getActiveDisplayCount ?? getActiveWindowsDisplayCount)();
      if (stopped || finished) return;
      diagnostic({ event: 'display_check', displayCount: count });
      if (count !== 1) {
        fail('UNSUPPORTED_SOURCE', 'Native capture currently requires exactly one active display. Use the browser screen-sharing mode for other layouts.');
        return;
      }
    } catch {
      diagnostic({ event: 'display_check', code: 'UNSUPPORTED_SOURCE' });
      fail('UNSUPPORTED_SOURCE', 'Unable to verify the desktop mapping. Native capture was not started.');
      return;
    }
    try {
      const spawnProcess = options.spawnProcess ?? ((executable, args) => spawn(executable, args, {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false
      }));
      child = spawnProcess(options.ffmpeg, buildCaptureArguments(options.frameRate, options.outputSize));
      child.once('spawn', () => diagnostic({ event: 'process_started' }));
      child.stdout.on('data', (chunk: Buffer) => {
        if (stopped) return;
        try { parser.push(chunk); }
        catch { fail('capture_stream', 'Native capture returned an invalid or unsynchronized video stream.'); }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stopped) return;
        // Only classify known DXGI/device/desktop transition failures. Never
        // log raw stderr (paths), retry arbitrary corruption, or evade revocation.
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
        accessLost ||= /\b(?:887a0026|887a0005|887a0007|80070005)\b|DXGI_ERROR_(?:ACCESS_LOST|DEVICE_REMOVED|DEVICE_RESET)|Desktop duplication access denied|Output parameters changed!/i.test(stderrTail);
        if (/887a0026|DXGI_ERROR_ACCESS_LOST/i.test(stderrTail)) evidence = 'access_lost';
        else if (/887a0005|DXGI_ERROR_DEVICE_REMOVED/i.test(stderrTail)) evidence = 'device_removed';
        else if (/887a0007|DXGI_ERROR_DEVICE_RESET/i.test(stderrTail)) evidence = 'device_reset';
        else if (/80070005|Desktop duplication access denied/i.test(stderrTail)) evidence = 'access_denied';
        else if (/Output parameters changed!/i.test(stderrTail)) evidence = 'output_changed';
        try { clock.pushStderr(chunk); }
        catch { fail('capture_stream', 'Native capture returned invalid or unsynchronized frame timestamps.'); }
      });
      child.on('error', () => { fail('capture_launch', 'Unable to launch FFmpeg. Check the configured FFmpeg executable.'); complete(); });
      child.on('close', (code, signal) => {
        diagnostic({ event: 'process_exit', exitCode: code, signal, hadFrame, expectedStop: requestedStop, evidence });
        if (!stopped) {
          if (accessLost) fail('capture_access_lost', 'Desktop capture access changed.');
        }
        if (!stopped) {
          try { parser.finish(); clock.finish(); }
          catch { fail('capture_stream', 'Native capture ended with an incomplete video stream.'); }
          if (!stopped && (code !== 0 || !hadFrame)) fail('capture_exit', 'FFmpeg stopped before capture completed. Check DXGI desktop access and FFmpeg support.');
        }
        if (!stopped) diagnostic({ event: 'completed', code: 'capture_eof' });
        complete();
      });
    } catch {
      fail('capture_launch', 'Unable to launch FFmpeg. Check the configured FFmpeg executable.');
      complete();
    }
  })();
  return { stop, done };
}
