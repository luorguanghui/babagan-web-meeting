import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { NativeCaptureFormat, NativeCaptureSourcePolicy, NativeCaptureSourceProof } from '@meeting/contracts';
import { FrameClock, type TimedFrame } from './timestamps.js';
import { Y4mParser } from './y4m.js';

export type CaptureSpawner = (executable: string, args: string[]) => ChildProcessWithoutNullStreams;
export interface CaptureOptions {
  ffmpeg: string;
  frameRate: 30 | 60;
  spawnProcess?: CaptureSpawner;
  startupTimeoutMs?: number;
  getActiveDisplayCount?: () => Promise<number>;
  getDesktopAvailability?: () => Promise<boolean>;
  sourcePolicy?: NativeCaptureSourcePolicy;
  outputSize?: { width: number; height: number };
  onFormat(format: NativeCaptureFormat): void;
  onFrame(frame: TimedFrame): void;
  onError(code: string, message: string): void;
}
export interface CaptureSession { stop(): void; done: Promise<void> }

/** Read desktop metadata only. Never switch desktops or request capture privileges. */
export async function getWindowsDesktopAvailability(): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const script = `Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class CaptureDesktop {
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
  static string Name(IntPtr desktop) {
    var value = new StringBuilder(256); int needed;
    if (!GetUserObjectInformation(desktop, 2, value, value.Capacity * 2, out needed)) throw new Win32Exception();
    return value.ToString();
  }
  public static bool Available() {
    var input = OpenInputDesktop(0, false, 1);
    if (input == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error == 5) return false;
      throw new Win32Exception(error);
    }
    try { return Name(input) == Name(GetThreadDesktop(GetCurrentThreadId())); }
    finally { CloseDesktop(input); }
  }
}
'@
if ([CaptureDesktop]::Available()) { 'available' } else { 'unavailable' }`;
  return new Promise<boolean>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
        if (error || !/^(?:available|unavailable)$/.test(stdout.trim())) reject(new Error('Unable to verify the input desktop'));
        else resolve(stdout.trim() === 'available');
      });
  });
}

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
  // Keep a bounded deadline instead of assigning jittered input PTS to fixed
  // buckets: adjacent real frames may land in one bucket and otherwise be lost.
  // Allow just under half a frame of jitter; discard stale deadlines after a
  // slow/static interval so resuming capture cannot create a catch-up burst.
  const period = `1/${frameRate}`;
  const selection = `if(isnan(prev_selected_t),st(0,t+${period})*0+1,if(gte(t+49/${frameRate * 100}+0.00000001,ld(0)),st(0,if(gte(t-ld(0),${period}-0.00000001),t+${period},ld(0)+${period}))*0+1,0))`;
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
  let killDeadline: ReturnType<typeof setTimeout> | undefined;
  let desktopWatch: ReturnType<typeof setInterval> | undefined;
  let lastFrameAt = 0, frameGeneration = 0, checkingDesktop = false;
  let verifiedSource: NativeCaptureSourceProof | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => resolveDone = resolve);
  const complete = () => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    clearTimeout(killDeadline);
    clearInterval(desktopWatch);
    resolveDone();
  };
  const stop = () => {
    if (stopped || finished) return;
    stopped = true;
    clearTimeout(deadline);
    clearInterval(desktopWatch);
    if (!child) { complete(); return; }
    child.kill();
    killDeadline = setTimeout(() => child?.kill('SIGKILL'), 1500);
    killDeadline.unref();
  };
  const fail = (code: string, message: string) => {
    if (stopped || finished) return;
    options.onError(code, message);
    stop();
  };
  const checkIdleDesktop = async () => {
    if (stopped || finished || checkingDesktop || Date.now() - lastFrameAt < 5000) return;
    checkingDesktop = true;
    const observedGeneration = frameGeneration;
    const stillIdle = () => !stopped && !finished && observedGeneration === frameGeneration && Date.now() - lastFrameAt >= 5000;
    try {
      const available = await (options.getDesktopAvailability ?? getWindowsDesktopAvailability)();
      if (!available && stillIdle()) {
        fail('capture_desktop_unavailable', 'The ordinary desktop is temporarily unavailable.');
      }
    } catch { if (stillIdle()) fail('capture_desktop_check', 'Unable to verify that the ordinary desktop is available.'); }
    finally { checkingDesktop = false; }
  };
  const clock = new FrameClock((frame) => {
    if (stopped) return;
    hadFrame = true;
    frameGeneration++;
    lastFrameAt = Date.now();
    // dup_frames=0 may legitimately have no new frames on a static desktop.
    // Observe desktop availability, never infer a GPU failure from silence.
    desktopWatch ??= setInterval(() => void checkIdleDesktop(), 5000);
    clearTimeout(deadline);
    options.onFrame(frame);
  });
  const parser = new Y4mParser({
    onFormat: ({ width, height }) => options.onFormat({ type: 'format', format: 'I420', width, height, frameRate: options.frameRate,
      ...(verifiedSource ? { source: verifiedSource } : {}) }),
    onFrame: (frame, index) => clock.pushFrame(frame, index)
  });
  const deadline = setTimeout(() => fail('capture_timeout', 'Native capture did not produce a frame before its startup deadline.'), options.startupTimeoutMs ?? 15_000);
  void (async () => {
    try {
      const count = await (options.getActiveDisplayCount ?? getActiveWindowsDisplayCount)();
      if (stopped || finished) return;
      if (count !== 1) {
        fail('UNSUPPORTED_SOURCE', 'Native capture currently requires exactly one active display. Use the browser screen-sharing mode for other layouts.');
        return;
      }
      // This proof follows the actual OS inventory check; it is never copied
      // from a client-supplied source description. Recovery repeats this check.
      if (options.sourcePolicy === 'single-active-monitor') verifiedSource = { kind: 'sole-active-monitor', activeDisplayCount: 1, outputIndex: 0 };
    } catch {
      fail('UNSUPPORTED_SOURCE', 'Unable to verify the desktop mapping. Native capture was not started.');
      return;
    }
    try {
      const spawnProcess = options.spawnProcess ?? ((executable, args) => spawn(executable, args, {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false
      }));
      child = spawnProcess(options.ffmpeg, buildCaptureArguments(options.frameRate, options.outputSize));
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
        accessLost ||= /\b(?:0x)?(?:887a0026|887a0005|887a0007|80070005)\b|DXGI_ERROR_(?:ACCESS_LOST|DEVICE_REMOVED|DEVICE_RESET)|Desktop duplication access denied|Output parameters changed!/i.test(stderrTail);
        try { clock.pushStderr(chunk); }
        catch { fail('capture_stream', 'Native capture returned invalid or unsynchronized frame timestamps.'); }
        if (accessLost) fail('capture_access_lost', 'Desktop capture access changed.');
      });
      child.on('error', () => { fail('capture_launch', 'Unable to launch FFmpeg. Check the configured FFmpeg executable.'); complete(); });
      child.on('close', (code) => {
        if (!stopped) {
          if (accessLost) fail('capture_access_lost', 'Desktop capture access changed.');
        }
        if (!stopped) {
          try { parser.finish(); clock.finish(); }
          catch { fail('capture_stream', 'Native capture ended with an incomplete video stream.'); }
          if (!stopped && (code !== 0 || !hadFrame)) fail('capture_exit', 'FFmpeg stopped before capture completed. Check DXGI desktop access and FFmpeg support.');
        }
        complete();
      });
    } catch {
      fail('capture_launch', 'Unable to launch FFmpeg. Check the configured FFmpeg executable.');
      complete();
    }
  })();
  return { stop, done };
}
