import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenStage } from './screen-stage.js';

function stream() { return {} as MediaStream; }
function installDocumentPip() {
  const pipDocument = document.implementation.createHTMLDocument();
  Object.defineProperty(pipDocument, 'defaultView', { value: window });
  const events = new EventTarget();
  const pipWindow = {
    document: pipDocument,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    close: vi.fn(() => events.dispatchEvent(new Event('pagehide'))),
    closed: false
  } as unknown as Window;
  const requestWindow = vi.fn(async () => pipWindow);
  vi.stubGlobal('documentPictureInPicture', { requestWindow });
  return { pipWindow, pipDocument, requestWindow, events };
}
function installNativePip(video: HTMLVideoElement) {
  Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true });
  const request = vi.fn(async () => {
    Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: video });
    video.dispatchEvent(new Event('enterpictureinpicture'));
    return {};
  });
  Object.defineProperty(video, 'requestPictureInPicture', { configurable: true, value: request });
  const exit = vi.fn(async () => {
    Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: null });
    video.dispatchEvent(new Event('leavepictureinpicture'));
  });
  Object.defineProperty(document, 'exitPictureInPicture', { configurable: true, value: exit });
  return { request, exit };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const prop of ['pictureInPictureEnabled', 'pictureInPictureElement', 'exitPictureInPicture', 'fullscreenElement', 'exitFullscreen']) Reflect.deleteProperty(document, prop);
});

describe('screen stage header and native display modes', () => {
  it('shows the actual sharer and only measured video dimensions', () => {
    const { container } = render(<ScreenStage stream={stream()} sharerName="Lin Yue" />);
    expect(screen.getByText('Now sharing: Lin Yue')).toBeInTheDocument();
    expect(screen.queryByText(/1080|1920/)).not.toBeInTheDocument();
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1536 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 864 });
    fireEvent.loadedMetadata(video);
    expect(screen.getByText('1536 × 864')).toBeInTheDocument();
  });

  it('does not offer receiver PiP on a local preview', () => {
    render(<ScreenStage stream={stream()} />);
    expect(screen.queryByRole('button', { name: 'Picture in picture' })).not.toBeInTheDocument();
  });

  it('prefers Document PiP and moves exactly the same audible media element', async () => {
    const { pipDocument, requestWindow } = installDocumentPip();
    const media = stream();
    const { container } = render(<ScreenStage stream={media} muted={false} pipAllowed sharerName="Lin Yue" />);
    const video = container.querySelector('video')!;
    const native = installNativePip(video);
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    await waitFor(() => expect(pipDocument.querySelector('video')).toBe(video));
    expect(requestWindow).toHaveBeenCalledOnce();
    expect(native.request).not.toHaveBeenCalled();
    expect(video.srcObject).toBe(media);
    expect(video.muted).toBe(false);
    expect(container.querySelector('video')).toBeNull();
    expect(within(pipDocument.body).getByText('Now sharing: Lin Yue')).toBeInTheDocument();
    expect(within(pipDocument.body).getByRole('button', { name: 'Return to meeting' })).toBeInTheDocument();
    expect(within(pipDocument.body).getByRole('button', { name: 'Close picture in picture' })).toBeInTheDocument();
  });

  it('restores the same media on system PiP close without ending the share', async () => {
    const { pipDocument, events } = installDocumentPip();
    const media = stream();
    const { container } = render(<ScreenStage stream={media} muted={false} pipAllowed />);
    const video = container.querySelector('video')!;
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    await waitFor(() => expect(pipDocument.querySelector('video')).toBe(video));
    act(() => { events.dispatchEvent(new Event('pagehide')); });
    expect(container.querySelector('video')).toBe(video);
    expect(video.srcObject).toBe(media);
    expect(screen.getByRole('button', { name: 'Picture in picture' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps metadata and volume updates working in the Document PiP window', async () => {
    const { pipDocument } = installDocumentPip();
    const media = stream();
    const { container, rerender } = render(<ScreenStage stream={media} muted={false} pipAllowed />);
    const video = container.querySelector('video')!;
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    await waitFor(() => expect(pipDocument.querySelector('video')).toBe(video));
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });
    fireEvent.loadedMetadata(video);
    expect(screen.getByText('1280 × 720')).toBeInTheDocument();
    rerender(<ScreenStage stream={media} muted={false} pipAllowed sharedAudioVolume={0.4} />);
    expect(video.volume).toBe(0.4);
  });

  it('closes Document PiP and releases media when the share ends', async () => {
    const { pipDocument, pipWindow } = installDocumentPip();
    const { container, rerender } = render(<ScreenStage stream={stream()} pipAllowed />);
    const video = container.querySelector('video')!;
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    await waitFor(() => expect(pipDocument.querySelector('video')).toBe(video));
    rerender(<ScreenStage />);
    expect(pipWindow.close).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(pipDocument.querySelector('video')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  it('closes Document PiP on sharer change and on unmount', async () => {
    const { pipDocument, pipWindow } = installDocumentPip();
    const media = stream();
    const { container, rerender, unmount } = render(<ScreenStage stream={media} shareIdentity="one" pipAllowed />);
    const video = container.querySelector('video')!;
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    await waitFor(() => expect(pipDocument.querySelector('video')).toBe(video));
    rerender(<ScreenStage stream={media} shareIdentity="two" pipAllowed />);
    expect(pipWindow.close).toHaveBeenCalledOnce();
    expect(container.querySelector('video')).toBe(video);
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    await waitFor(() => expect(pipDocument.querySelector('video')).toBe(video));
    unmount();
    expect(pipWindow.close).toHaveBeenCalledTimes(2);
    expect(video.srcObject).toBeNull();
  });

  it('closes a pending PiP request if the share ends before it resolves', async () => {
    const { pipWindow } = installDocumentPip();
    let resolve!: (value: Window) => void;
    vi.stubGlobal('documentPictureInPicture', { requestWindow: () => new Promise<Window>((done) => { resolve = done; }) });
    const { rerender } = render(<ScreenStage stream={stream()} pipAllowed />);
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    rerender(<ScreenStage />);
    await act(async () => { resolve(pipWindow); });
    expect(pipWindow.close).toHaveBeenCalledOnce();
    expect(screen.queryByText('Playing in picture in picture')).not.toBeInTheDocument();
  });

  it('falls back to native video PiP and returns via the same toggle', async () => {
    const { container } = render(<ScreenStage stream={stream()} muted={false} pipAllowed />);
    const video = container.querySelector('video')!;
    const native = installNativePip(video);
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Return to meeting' })).toBeInTheDocument());
    expect(native.request).toHaveBeenCalledOnce();
    expect(container.querySelector('video')).toBe(video);
    fireEvent.click(screen.getByRole('button', { name: 'Return to meeting' }));
    await waitFor(() => expect(native.exit).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Picture in picture' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports unsupported PiP honestly without creating an in-page imitation', async () => {
    const { container } = render(<ScreenStage stream={stream()} pipAllowed />);
    const video = container.querySelector('video');
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Picture in picture is not supported by this browser.');
    expect(container.querySelectorAll('video')).toHaveLength(1);
    expect(container.querySelector('video')).toBe(video);
  });

  it('reports denied Document PiP and does not bypass denial with native PiP', async () => {
    vi.stubGlobal('documentPictureInPicture', { requestWindow: vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError')) });
    const { container } = render(<ScreenStage stream={stream()} pipAllowed />);
    const native = installNativePip(container.querySelector('video')!);
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Your browser blocked picture in picture. Allow it and try again.');
    expect(native.request).not.toHaveBeenCalled();
  });

  it('shows only an icon exit control in fullscreen and restores the header afterward', async () => {
    const { container } = render(<ScreenStage stream={stream()} sharerName="Lin Yue" pipAllowed />);
    const stage = screen.getByRole('region', { name: 'Shared screen stage' });
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 1080 });
    fireEvent.loadedMetadata(video);
    expect(screen.getByText('Now sharing: Lin Yue')).toBeVisible();
    const header = container.querySelector('.screen-stage-header')!;
    expect(document.body).toHaveFocus();
    Object.defineProperty(stage, 'requestFullscreen', { configurable: true, value: async () => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: stage });
      document.dispatchEvent(new Event('fullscreenchange'));
    } });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: async () => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      document.dispatchEvent(new Event('fullscreenchange'));
    } });
    fireEvent.click(screen.getByRole('button', { name: 'View shared screen fullscreen' }));
    await waitFor(() => expect(header).not.toBeVisible());
    expect(stage).toHaveAttribute('data-fullscreen');
    expect(screen.queryByRole('button', { name: 'Picture in picture' })).not.toBeInTheDocument();
    const exit = screen.getByRole('button', { name: 'Exit full screen' });
    expect(exit).toHaveTextContent('');
    expect(exit.querySelector('svg')).not.toBeNull();
    expect(screen.getAllByRole('button')).toEqual([exit]);
    expect(exit).toHaveFocus();
    expect(container.querySelector('video')).toBe(video);
    expect(video.style.objectFit).toBe('contain');
    fireEvent.click(exit);
    await waitFor(() => expect(header).toBeVisible());
    expect(stage).not.toHaveAttribute('data-fullscreen');
    expect(screen.getByRole('button', { name: 'Picture in picture' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'View shared screen fullscreen' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'View shared screen fullscreen' })).toHaveFocus();
    expect(container.querySelector('video')).toBe(video);
    // Native Escape/browser-exit events follow the same focus-return path.
    fireEvent.click(screen.getByRole('button', { name: 'View shared screen fullscreen' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exit full screen' })).toHaveFocus());
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(screen.getByRole('button', { name: 'View shared screen fullscreen' })).toHaveFocus();
  });

  it('toggles native full screen without replacing the media element', async () => {
    const { container } = render(<ScreenStage stream={stream()} />);
    const stage = screen.getByRole('region', { name: 'Shared screen stage' });
    const video = container.querySelector('video');
    const request = vi.fn(async () => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: stage });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    const exit = vi.fn(async () => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    Object.defineProperty(stage, 'requestFullscreen', { configurable: true, value: request });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
    fireEvent.click(screen.getByRole('button', { name: 'View shared screen fullscreen' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    await waitFor(() => expect(exit).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledOnce();
    expect(container.querySelector('video')).toBe(video);
  });
});

describe('PiP adaptive stream continuity', () => {
  it('keeps LiveKit visible in a backgrounded opener without extra audible subscriptions', async () => {
    const { pipDocument, events } = installDocumentPip();
    type Info = { pictureInPicture: boolean; visible: boolean; observe: () => void; stopObserving: () => void; width: () => number };
    const observed = new Set<Info>();
    const media = stream();
    const track = {
      attach: vi.fn((element: HTMLMediaElement) => { element.srcObject = media; return element; }),
      detach: vi.fn((element: HTMLMediaElement) => { if (element.srcObject === media) element.srcObject = null; return element; }),
      isAdaptiveStream: true,
      observeElementInfo(info: Info) { observed.add(info); info.observe(); },
      stopObservingElementInfo(info: Info) { observed.delete(info); info.stopObserving(); }
    };
    const audio = { attach: vi.fn((element: HTMLMediaElement) => element), detach: vi.fn((element: HTMLMediaElement) => element) };
    const { container } = render(<ScreenStage track={track} audioTrack={audio} pipAllowed />);
    const video = container.querySelector('video')!;
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    await waitFor(() => expect(pipDocument.querySelector('video')).toBe(video));
    expect([...observed].some(info => info.pictureInPicture && info.visible && info.width() > 0)).toBe(true);
    expect(track.attach).toHaveBeenCalledOnce();
    expect(audio.attach).toHaveBeenCalledOnce();
    act(() => { events.dispatchEvent(new Event('pagehide')); });
    expect(observed.size).toBe(0);
    expect(video.srcObject).toBe(media);
  });

  it('stages transport handover probes in the visible PiP document and retains the video', async () => {
    const { pipDocument } = installDocumentPip();
    const media = stream();
    const next = stream();
    const { container, rerender } = render(<ScreenStage stream={media} shareIdentity="one" pipAllowed />);
    const video = container.querySelector('video')!;
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    await waitFor(() => expect(pipDocument.querySelector('video')).toBe(video));
    const track = { attach: vi.fn((element: HTMLMediaElement) => { element.srcObject = next; return element; }), detach: vi.fn((element: HTMLMediaElement) => element) };
    rerender(<ScreenStage track={track} shareIdentity="one" pipAllowed />);
    expect(video.srcObject).toBe(media);
    const probe = pipDocument.querySelector('video[data-stage-probe]')!;
    expect(probe).not.toBeNull();
    fireEvent.playing(probe);
    expect(pipDocument.querySelector('video')).toBe(video);
    expect(video.srcObject).toBe(next);
    expect(pipDocument.querySelector('video[data-stage-probe]')).toBeNull();
  });
});

describe('screen stage pending and failure states', () => {
  it('names the actual sharer without claiming playback before the first frame', () => {
    render(<ScreenStage stream={stream()} sharerName="Lin Yue" pipAllowed sourcePending />);
    expect(screen.getByText(/Lin Yue.*Connecting shared screen/)).toBeInTheDocument();
    expect(screen.queryByText('Now sharing: Lin Yue')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Picture in picture' })).toBeDisabled();
  });

  it('reports a fullscreen rejection instead of silently ignoring it', async () => {
    render(<ScreenStage stream={stream()} />);
    fireEvent.click(screen.getByRole('button', { name: 'View shared screen fullscreen' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Full screen is unavailable or was blocked by your browser.');
  });

  it('exits native fullscreen when the share ends', async () => {
    const { rerender } = render(<ScreenStage stream={stream()} />);
    const stage = screen.getByRole('region', { name: 'Shared screen stage' });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: stage });
    const exit = vi.fn(async () => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
    rerender(<ScreenStage />);
    await waitFor(() => expect(exit).toHaveBeenCalledOnce());
  });

  it('keeps an in-progress handover probe alive when the system PiP window closes', async () => {
    const { pipDocument, events } = installDocumentPip();
    const media = stream();
    const next = stream();
    const { container, rerender } = render(<ScreenStage stream={media} pipAllowed />);
    const video = container.querySelector('video')!;
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    await waitFor(() => expect(pipDocument.querySelector('video')).toBe(video));
    const track = { attach: (element: HTMLMediaElement) => { element.srcObject = next; return element; }, detach: (element: HTMLMediaElement) => element };
    rerender(<ScreenStage track={track} pipAllowed />);
    const probe = pipDocument.querySelector('video[data-stage-probe]')!;
    act(() => { events.dispatchEvent(new Event('pagehide')); });
    expect(container.contains(probe)).toBe(true);
    fireEvent.playing(probe);
    expect(video.srcObject).toBe(next);
    expect(container.querySelector('video')).toBe(video);
  });
});

describe('native PiP close failures', () => {
  it('does not claim to close a system window if the browser rejects the exit', async () => {
    const { container } = render(<ScreenStage stream={stream()} pipAllowed />);
    const video = container.querySelector('video')!;
    installNativePip(video);
    Object.defineProperty(document, 'exitPictureInPicture', { configurable: true, value: vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError')) });
    fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Return to meeting' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Return to meeting' }));
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Return to meeting' })).toHaveAttribute('aria-pressed', 'true');
    // The browser's own close event still clears the state after the failed exit.
    act(() => { video.dispatchEvent(new Event('leavepictureinpicture')); });
    expect(screen.getByRole('button', { name: 'Picture in picture' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('handover audio ownership', () => {
  it('stages only video and attaches incoming shared audio once on the original player', () => {
    const { container, rerender } = render(<ScreenStage stream={stream()} muted={false} />);
    const video = container.querySelector('video')!;
    const next = stream();
    const track = { attach: (element: HTMLMediaElement) => { element.srcObject = next; return element; }, detach: (element: HTMLMediaElement) => element };
    const audio = { attach: vi.fn((element: HTMLMediaElement) => element), detach: vi.fn((element: HTMLMediaElement) => element) };
    rerender(<ScreenStage track={track} audioTrack={audio} muted={false} />);
    const probe = container.querySelector('video[data-stage-probe]')!;
    expect(audio.attach).not.toHaveBeenCalled();
    fireEvent.playing(probe);
    expect(audio.attach).toHaveBeenCalledExactlyOnceWith(video);
    expect(audio.detach).not.toHaveBeenCalledWith(probe);
  });
});
