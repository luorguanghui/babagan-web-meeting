/** One media host moves between documents. No extra player, capture, or audio subscription. */
export interface PictureInPictureLabels {
  sharing: string;
  name: string;
  close: string;
  returnToMeeting: string;
  audio: string;
}

export interface ScreenPictureInPictureSession {
  kind: 'document' | 'video';
  close(): Promise<void> | void;
  updateLabels(labels: PictureInPictureLabels): void;
}

export class ScreenPictureInPictureError extends Error {
  constructor(readonly reason: 'unsupported' | 'denied' | 'failed') { super(reason); }
}

interface DocumentPipApi {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}

function pipError(error: unknown): ScreenPictureInPictureError {
  // DOMExceptions may come from a different window/realm.
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : '';
  return new ScreenPictureInPictureError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotSupportedError' ? 'unsupported' : 'failed');
}

const pipStyles = `
  :root{color-scheme:dark;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:#202422;color:#f5f7f4}
  *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
  body{display:flex;flex-direction:column}header,footer{display:flex;align-items:center;gap:10px;flex-shrink:0;padding:10px 14px;background:#262b28}
  header{min-height:52px;font-size:14px}header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;flex:1}
  .pip-avatar{display:grid;place-items:center;border-radius:50%;width:30px;height:30px;flex-shrink:0;background:#e4ecdd;color:#46673b;font-weight:700}
  button{font:inherit;color:inherit;background:transparent;border:1px solid #68716b;border-radius:8px;padding:8px 12px;cursor:pointer}
  button:hover{background:#414b43}button:focus-visible{outline:3px solid #bbd8a1;outline-offset:2px}.pip-close{border:0;font-size:24px;line-height:1;padding:4px 8px}
  .screen-stage-media{flex:1;min-height:0;width:100%;display:flex;background:#151a17;align-items:center;justify-content:center;overflow:hidden}
  .screen-stage-media video{width:100%;height:100%;display:block;object-fit:contain;background:#151a17}
  footer{justify-content:space-between;min-height:54px;font-size:12px;color:#d6ded6}footer span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}footer button{flex-shrink:0}
`;

export async function openScreenPictureInPicture(options: {
  mediaHost: HTMLElement;
  home: HTMLElement;
  video: HTMLVideoElement;
  labels: PictureInPictureLabels;
  onClose: () => void;
}): Promise<ScreenPictureInPictureSession> {
  const { mediaHost, home, video, labels, onClose } = options;
  const ownerDocument = home.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const api = (ownerWindow as Window & { documentPictureInPicture?: DocumentPipApi }).documentPictureInPicture;
  if (api?.requestWindow) {
    let pipWindow: Window;
    try {
      pipWindow = await api.requestWindow({ width: 640, height: Math.round(640 / ((video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 16 / 9)) + 106 });
    } catch (error) {
      // A denial is not an invitation to bypass browser policy with another API.
      if (pipError(error).reason !== 'unsupported') throw pipError(error);
      return openNativePictureInPicture(video, ownerDocument, onClose);
    }
    const doc = pipWindow.document;
    const style = doc.createElement('style');
    style.textContent = pipStyles;
    doc.head.append(style);
    const header = doc.createElement('header');
    const avatar = doc.createElement('span');
    avatar.className = 'pip-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    const title = doc.createElement('strong');
    const closeButton = doc.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'pip-close';
    closeButton.textContent = '×';
    header.append(avatar, title, closeButton);
    const footer = doc.createElement('footer');
    const audio = doc.createElement('span');
    const returnButton = doc.createElement('button');
    returnButton.type = 'button';
    footer.append(audio, returnButton);
    doc.body.append(header, mediaHost, footer);
    let closed = false;
    const restore = () => {
      if (closed) return;
      closed = true;
      pipWindow.removeEventListener('pagehide', restore);
      home.append(mediaHost);
      header.remove();
      footer.remove();
      style.remove();
      onClose();
    };
    const close = () => {
      if (closed) return;
      restore();
      pipWindow.close();
    };
    closeButton.addEventListener('click', close);
    returnButton.addEventListener('click', () => { ownerWindow.focus(); close(); });
    pipWindow.addEventListener('pagehide', restore);
    const session: ScreenPictureInPictureSession = {
      kind: 'document', close,
      updateLabels(next) {
        doc.title = next.sharing;
        doc.documentElement.lang = ownerDocument.documentElement.lang;
        avatar.textContent = [...next.name][0] ?? '';
        title.textContent = next.sharing;
        closeButton.setAttribute('aria-label', next.close);
        closeButton.title = next.close;
        returnButton.textContent = next.returnToMeeting;
        audio.textContent = next.audio;
      }
    };
    session.updateLabels(labels);
    return session;
  }
  return openNativePictureInPicture(video, ownerDocument, onClose);
}

async function openNativePictureInPicture(video: HTMLVideoElement, doc: Document, onClose: () => void): Promise<ScreenPictureInPictureSession> {
  if (doc.pictureInPictureEnabled === false || typeof video.requestPictureInPicture !== 'function') throw new ScreenPictureInPictureError('unsupported');
  let closed = false;
  const didClose = () => {
    if (closed) return;
    closed = true;
    video.removeEventListener('leavepictureinpicture', didClose);
    onClose();
  };
  video.addEventListener('leavepictureinpicture', didClose);
  try { await video.requestPictureInPicture(); }
  catch (error) { video.removeEventListener('leavepictureinpicture', didClose); throw pipError(error); }
  return {
    kind: 'video',
    async close() {
      if (closed) return;
      if (doc.pictureInPictureElement === video) await doc.exitPictureInPicture();
      didClose();
    },
    updateLabels() { /* Native video PiP has browser-owned chrome. */ }
  };
}

/** Structural LiveKit ElementInfo adapter: only visibility/dimensions, never another media attachment. */
interface PipElementInfo {
  element: object;
  width(): number;
  height(): number;
  visible: boolean;
  pictureInPicture: boolean;
  visibilityChangedAt: number | undefined;
  handleResize?: () => void;
  handleVisibilityChanged?: () => void;
  observe(): void;
  stopObserving(): void;
}
interface AdaptiveTrack {
  isAdaptiveStream?: boolean;
  observeElementInfo?(info: PipElementInfo): void;
  stopObservingElementInfo?(info: PipElementInfo): void;
}

export function keepTrackVisibleInPictureInPicture(track: object, video: HTMLVideoElement): () => void {
  const adaptive = track as AdaptiveTrack;
  if (!adaptive.isAdaptiveStream || !adaptive.observeElementInfo || !adaptive.stopObservingElementInfo) return () => undefined;
  let observer: ResizeObserver | undefined;
  const info: PipElementInfo = {
    // This is a visibility lease, not an attached element. Distinct identity means
    // detaching the media element during handover cannot remove the PiP lease.
    element: {},
    width: () => Math.max(video.clientWidth || video.videoWidth, 1),
    height: () => Math.max(video.clientHeight || video.videoHeight, 1),
    visible: true,
    pictureInPicture: true,
    visibilityChangedAt: Date.now(),
    observe() {
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => info.handleResize?.());
        observer.observe(video);
      }
    },
    stopObserving() { observer?.disconnect(); }
  };
  adaptive.observeElementInfo(info);
  return () => {
    info.visible = false;
    info.pictureInPicture = false;
    adaptive.stopObservingElementInfo?.(info);
  };
}
