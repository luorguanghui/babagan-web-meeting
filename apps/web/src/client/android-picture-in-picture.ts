import type { PictureInPictureLabels, ScreenPictureInPictureSession } from '../components/screen-picture-in-picture.js';
import { ClientHostError, type ClientHost } from './host-bridge.js';

interface AndroidPipOptions {
  mediaHost: HTMLElement;
  home: HTMLElement;
  video: HTMLVideoElement;
  labels: PictureInPictureLabels;
  onClose: () => void;
  signal?: AbortSignal;
}

const displayed = new WeakSet<Document>();
const styles = `
  [data-babagan-android-pip] { position:fixed!important; inset:0!important; z-index:2147483647!important; display:flex!important; align-items:center!important; justify-content:center!important; margin:0!important; padding:0!important; border:0!important; background:#111!important; color:#fff!important; overflow:hidden!important; }
  [data-babagan-android-pip] > .screen-stage-media { position:relative!important; display:flex!important; align-items:center!important; justify-content:center!important; width:100%!important; height:100%!important; min-width:0!important; min-height:0!important; max-width:none!important; max-height:none!important; background:#111!important; }
  [data-babagan-android-pip] video:not([data-stage-probe]) { display:block!important; width:100%!important; height:100%!important; object-fit:contain!important; background:#111!important; }
  [data-babagan-android-pip] > p { color:#fff; font:14px/1.5 system-ui,sans-serif; text-align:center; padding:16px; }
`;

function size(video: HTMLVideoElement): { width: number; height: number } {
  const valid = (value: number) => Number.isInteger(value) && value > 0 && value <= 16384;
  return valid(video.videoWidth) && valid(video.videoHeight)
    ? { width: video.videoWidth, height: video.videoHeight } : { width: 16, height: 9 };
}
function reply(value: unknown, sessionId: string): value is { sessionId: string; active: boolean; released?: boolean } {
  return Boolean(value) && typeof value === 'object' && (value as { sessionId?: unknown }).sessionId === sessionId
    && typeof (value as { active?: unknown }).active === 'boolean';
}

/** The Activity is the system PiP window; only the same existing media host fills its WebView. */
export async function openAndroidPictureInPicture(host: ClientHost, options: AndroidPipOptions): Promise<ScreenPictureInPictureSession> {
  const { mediaHost, home, video, onClose, signal } = options;
  if (host.platform !== 'android') throw new ClientHostError('unsupported', 'Android picture in picture requires its native host.');
  if (signal?.aborted) throw new DOMException('Picture in picture cancelled.', 'AbortError');
  const doc = home.ownerDocument;
  if (displayed.has(doc)) throw new ClientHostError('busy', 'Another picture-in-picture session is active.');
  // WebView's fullscreen custom view must be dismissed before the Activity is minimized.
  if (doc.fullscreenElement) await doc.exitFullscreen();
  if (signal?.aborted) throw new DOMException('Picture in picture cancelled.', 'AbortError');
  if (displayed.has(doc)) throw new ClientHostError('busy', 'Another picture-in-picture session is active.');
  displayed.add(doc);
  const sessionId = crypto.randomUUID();
  const style = doc.createElement('style'); style.textContent = styles;
  const overlay = doc.createElement('div'); overlay.dataset.babaganAndroidPip = sessionId;
  overlay.setAttribute('role', 'region'); overlay.setAttribute('aria-label', options.labels.sharing);
  const previousFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : undefined;
  const inertElements = Array.from(doc.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement)
    .map(element => ({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }));
  const overflow = doc.body.style.getPropertyValue('overflow'), overflowPriority = doc.body.style.getPropertyPriority('overflow');
  for (const entry of inertElements) { entry.element.inert = true; entry.element.setAttribute('aria-hidden', 'true'); }
  doc.body.style.setProperty('overflow', 'hidden', 'important');
  doc.head.append(style); overlay.append(mediaHost); doc.body.append(overlay);

  let terminal = false, released = false, notified = false, cleaned = false, mediaRestored = false, opened = false, entryFailed = false;
  let labels = options.labels;
  let closePromise: Promise<void> | undefined;
  let nativeExitSent = false;
  let detach: () => void = () => undefined;
  let returnWait: { resolve: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const notify = () => { if (!notified && (!entryFailed || opened)) { notified = true; onClose(); } };
  const restoreMedia = () => {
    if (mediaRestored) return;
    mediaRestored = true;
    home.append(mediaHost);
    video.removeEventListener('resize', resized);
    video.removeEventListener('loadedmetadata', resized);
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true; terminal = true;
    restoreMedia(); detach(); signal?.removeEventListener('abort', aborted);
    for (const entry of inertElements) {
      entry.element.inert = entry.inert;
      if (entry.ariaHidden === null) entry.element.removeAttribute('aria-hidden'); else entry.element.setAttribute('aria-hidden', entry.ariaHidden);
    }
    if (doc.body.style.getPropertyValue('overflow') === 'hidden' && doc.body.style.getPropertyPriority('overflow') === 'important') {
      if (overflow) doc.body.style.setProperty('overflow', overflow, overflowPriority); else doc.body.style.removeProperty('overflow');
    }
    overlay.remove(); style.remove(); displayed.delete(doc);
    if (returnWait) { clearTimeout(returnWait.timer); returnWait.resolve(); returnWait = undefined; }
    if (previousFocus?.isConnected && !previousFocus.inert) previousFocus.focus({ preventScroll: true });
  };
  const placeholder = () => {
    restoreMedia();
    const message = doc.createElement('p'); message.textContent = labels.returnToMeeting;
    overlay.replaceChildren(message);
  };
  const resumeMedia = () => {
    if (cleaned || terminal) return;
    released = false; mediaRestored = false; overlay.replaceChildren(mediaHost);
    video.addEventListener('resize', resized); video.addEventListener('loadedmetadata', resized);
  };
  const releaseNative = async (returnToMeeting: boolean) => {
    nativeExitSent = true;
    const result = await host.request('pictureInPicture.exit', { sessionId, returnToMeeting }, { timeoutMs: 10_000 });
    if (!reply(result, sessionId)) throw new ClientHostError('failed', 'Invalid picture-in-picture exit response.');
    if (!result.active || result.released === true) { cleanup(); notify(); return; }
    if (returnToMeeting && !cleaned) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { returnWait = undefined; reject(new ClientHostError('timeout', 'Android did not confirm leaving picture in picture.')); }, 10_000);
      returnWait = { resolve, timer };
    });
  };
  detach = host.subscribe(event => {
    if (event.event !== 'pictureInPicture.state' || event.sessionId !== sessionId || typeof event.active !== 'boolean' || cleaned) return;
    if (!event.active) { if (event.reason === 'enter-failed' && !opened) entryFailed = true; cleanup(); notify(); }
    else if (event.released === true || event.reason === 'released' || event.reason === 'navigation') {
      released = true; cleanup(); notify(); // The native host now owns the released-state placeholder.
    }
  });
  function resized() {
    if (!terminal && !released) void host.request('pictureInPicture.update', { sessionId, ...size(video) }).catch(() => undefined);
  }
  function aborted() {
    if (cleaned) return;
    released = true; placeholder();
    // If the bridge reply is lost, keep only the black placeholder until the OS exit
    // event. A navigation destroys this document and the native released placeholder takes over.
    void releaseNative(false).catch(() => undefined);
  }
  video.addEventListener('resize', resized); video.addEventListener('loadedmetadata', resized);
  signal?.addEventListener('abort', aborted, { once: true });

  try {
    const result = await host.request('pictureInPicture.enter', { sessionId, ...size(video) }, { signal, timeoutMs: 15_000 });
    if (!reply(result, sessionId) || !result.active) throw new ClientHostError('failed', 'The Android host did not enter picture in picture.');
    if (signal?.aborted || terminal || released) {
      if (!nativeExitSent) void releaseNative(false).catch(() => undefined);
      throw new DOMException('Picture in picture cancelled.', 'AbortError');
    }
    opened = true;
    return {
      kind: 'android',
      close(closeOptions) {
        if (cleaned) return;
        if (closePromise) return closePromise;
        const returnToMeeting = closeOptions?.returnToMeeting === true;
        // React may remove this media host immediately after a layout-effect cleanup.
        // Return it synchronously; the interim black surface prevents the whole room shrinking.
        released = true; placeholder();
        closePromise = releaseNative(returnToMeeting).catch(error => {
          closePromise = undefined;
          if (!returnToMeeting) return;
          resumeMedia();
          throw error;
        });
        return closePromise;
      },
      updateLabels(next) { labels = next; overlay.setAttribute('aria-label', next.sharing); },
    };
  } catch (error) {
    entryFailed = true;
    // Native enter can succeed while a cancelled/timeout response is in transit.
    const uncertain = signal?.aborted || error instanceof ClientHostError && error.code === 'timeout';
    if (uncertain && !cleaned) {
      released = true; placeholder();
      if (!nativeExitSent && !terminal) void releaseNative(false).catch(() => undefined);
    } else {
      if (!nativeExitSent && !terminal) void releaseNative(false).catch(() => undefined);
      cleanup();
    }
    throw error;
  }
}
