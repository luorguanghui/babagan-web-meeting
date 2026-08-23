import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ScreenStage } from './screen-stage.js';

type AttachDetach = (element: HTMLMediaElement) => HTMLMediaElement;

interface FakeTrackLike {
  stream: unknown;
  attach: Mock<AttachDetach>;
  detach: Mock<AttachDetach>;
}

function makeStream(): MediaStream {
  return {} as unknown as MediaStream;
}

function makeTrack(): FakeTrackLike {
  const stream = { id: 'livekit-stream' };
  const attach = vi.fn<AttachDetach>((element) => {
    (element as unknown as { srcObject: unknown }).srcObject = stream;
    return element;
  });
  const detach = vi.fn<AttachDetach>((element) => {
    if ((element as unknown as { srcObject: unknown }).srcObject === stream) {
      (element as unknown as { srcObject: unknown }).srcObject = null;
    }
    return element;
  });
  return { stream, attach, detach };
}

function makeVisibilityGatedTrack(): FakeTrackLike {
  const track = makeTrack();
  track.attach.mockImplementation((element) => {
    (element as unknown as { srcObject: unknown }).srcObject = track.stream;
    queueMicrotask(() => {
      if (!element.hidden) fireEvent(element, new Event('playing'));
    });
    return element;
  });
  return track;
}

/** Audio tracks join the element's existing stream; they must not replace srcObject. */
function makeAudioTrack() {
  return {
    attach: vi.fn<AttachDetach>((element) => element),
    detach: vi.fn<AttachDetach>((element) => element)
  };
}

function getVisibleVideo(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector<HTMLVideoElement>('video:not([data-stage-probe])');
  if (!video) throw new Error('no visible video in the stage');
  return video;
}

function getProbe(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('video[data-stage-probe]');
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('screen stage dual-source rendering', () => {
  it('renders a P2P stream directly when no source was shown before', () => {
    const stream = makeStream();
    const { container } = render(<ScreenStage stream={stream} />);

    expect(getVisibleVideo(container).srcObject).toBe(stream);
  });

  it('attaches a LiveKit track (and its audio) directly when no source was shown before', () => {
    const track = makeTrack();
    const audio = makeAudioTrack();
    const { container } = render(<ScreenStage track={track} audioTrack={audio} />);
    const video = getVisibleVideo(container);

    expect(track.attach).toHaveBeenCalledWith(video);
    expect(audio.attach).toHaveBeenCalledWith(video);
    expect(video.srcObject).toBe(track.stream);
  });

  it('keeps the previous stream visible until the new LiveKit track renders its first frame', () => {
    const stream = makeStream();
    const track = makeTrack();
    const { container, rerender } = render(<ScreenStage stream={stream} />);
    const video = getVisibleVideo(container);

    rerender(<ScreenStage track={track} />);

    // The old stream stays on the visible video; the track is staged on a transparent probe.
    expect(video.srcObject).toBe(stream);
    const probe = getProbe();
    expect(probe).not.toBeNull();
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(track.attach).toHaveBeenCalledWith(probe);
    expect(track.attach).not.toHaveBeenCalledWith(video);

    // First frame on the probe commits the switch.
    fireEvent(probe!, new Event('loadedmetadata'));

    expect(track.attach).toHaveBeenCalledTimes(2);
    expect(track.attach).toHaveBeenLastCalledWith(video);
    expect(video.srcObject).toBe(track.stream);
    expect(track.detach).toHaveBeenCalledWith(probe);
    expect(getProbe()).toBeNull();
  });

  it('lets a visibility-gated LiveKit track render while preserving the previous stream', async () => {
    const stream = makeStream();
    const track = makeVisibilityGatedTrack();
    const { container, rerender } = render(<ScreenStage stream={stream} />);
    const video = getVisibleVideo(container);

    rerender(<ScreenStage track={track} />);

    expect(video.srcObject).toBe(stream);
    await waitFor(() => expect(video.srcObject).toBe(track.stream));
    expect(getProbe()).toBeNull();
  });

  it('keeps the previous LiveKit track visible until the new P2P stream renders its first frame', () => {
    const track = makeTrack();
    const { container, rerender } = render(<ScreenStage track={track} />);
    const video = getVisibleVideo(container);
    const stream = makeStream();

    rerender(<ScreenStage stream={stream} />);

    expect(video.srcObject).toBe(track.stream);
    const probe = getProbe();
    expect(probe).not.toBeNull();
    expect(probe!.srcObject).toBe(stream);

    // First frame can arrive via `playing` too.
    fireEvent(probe!, new Event('playing'));

    expect(video.srcObject).toBe(stream);
    expect(track.detach).toHaveBeenCalledWith(video);
    expect(getProbe()).toBeNull();
  });

  it('applies audio-only changes on the same LiveKit track immediately', () => {
    const track = makeTrack();
    const audio1 = makeAudioTrack();
    const audio2 = makeAudioTrack();
    const { container, rerender } = render(<ScreenStage track={track} audioTrack={audio1} />);
    const video = getVisibleVideo(container);

    rerender(<ScreenStage track={track} audioTrack={audio2} />);

    expect(audio2.attach).toHaveBeenCalledWith(video);
    expect(audio1.detach).toHaveBeenCalledWith(video);
    expect(video.srcObject).toBe(track.stream);
    expect(getProbe()).toBeNull();
  });

  it('clears the stage immediately when the share ends (stream -> none)', () => {
    const stream = makeStream();
    const { container, rerender } = render(<ScreenStage stream={stream} />);
    const video = getVisibleVideo(container);

    rerender(<ScreenStage />);

    expect(video.srcObject).toBeNull();
    expect(getProbe()).toBeNull();
  });

  it('clears the stage and detaches the track when the share ends (track -> none)', () => {
    const track = makeTrack();
    const audio = makeAudioTrack();
    const { container, rerender } = render(<ScreenStage track={track} audioTrack={audio} />);
    const video = getVisibleVideo(container);

    rerender(<ScreenStage />);

    expect(audio.detach).toHaveBeenCalledWith(video);
    expect(track.detach).toHaveBeenCalledWith(video);
    expect(video.srcObject).toBeNull();
  });

  it('shows the empty state when there is no source', () => {
    const { container } = render(<ScreenStage />);

    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('.screen-stage-empty')).not.toBeNull();
  });

  it('keeps the old source visible when the new source never renders a frame', () => {
    const stream = makeStream();
    const track = makeTrack();
    const { container, rerender } = render(<ScreenStage stream={stream} />);
    const video = getVisibleVideo(container);

    rerender(<ScreenStage track={track} />);

    // No first frame on the probe: the previous stream stays visible.
    expect(video.srcObject).toBe(stream);
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(track.attach).not.toHaveBeenCalledWith(video);
  });

  it('forces a stalled LiveKit handover onto the visible stage after ten seconds', () => {
    vi.useFakeTimers();
    const stream = makeStream();
    const track = makeTrack();
    const onSourceReady = vi.fn();
    const { container, rerender } = render(<ScreenStage stream={stream} onSourceReady={onSourceReady} />);
    const video = getVisibleVideo(container);

    rerender(<ScreenStage track={track} onSourceReady={onSourceReady} />);
    act(() => { vi.advanceTimersByTime(9_999); });
    expect(video.srcObject).toBe(stream);
    expect(onSourceReady).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1); });
    expect(video.srcObject).toBe(track.stream);
    expect(getProbe()).toBeNull();
    expect(onSourceReady).toHaveBeenCalledOnce();
  });

  it('respects an explicit muted prop for remote P2P audio', () => {
    const stream = makeStream();
    const { container } = render(<ScreenStage stream={stream} muted={false} />);
    const video = getVisibleVideo(container);

    expect(video.muted).toBe(false);
  });

  it('uses native shared-audio volume for live changes without WebAudio', () => {
    const stream = makeStream();
    const audioContext = vi.fn(function () { return {}; });
    vi.stubGlobal('AudioContext', audioContext);
    const { container, rerender } = render(
      <ScreenStage stream={stream} muted={false} sharedAudioVolume={1} />
    );
    const video = getVisibleVideo(container);
    expect(video.volume).toBe(1);

    rerender(<ScreenStage stream={stream} muted={false} sharedAudioVolume={0.4} />);
    expect(video.volume).toBe(0.4);
    expect(audioContext).not.toHaveBeenCalled();
  });

  it('keeps the selected native volume through a stream-to-track handover', () => {
    const stream = makeStream();
    const track = makeTrack();
    const { container, rerender } = render(
      <ScreenStage stream={stream} muted={false} sharedAudioVolume={0.4} />
    );
    const video = getVisibleVideo(container);

    rerender(<ScreenStage track={track} muted={false} sharedAudioVolume={0.4} />);
    fireEvent(getProbe()!, new Event('loadedmetadata'));

    expect(getVisibleVideo(container)).toBe(video);
    expect(video.volume).toBe(0.4);
  });

  it('fully mutes shared audio at zero percent', () => {
    const { container } = render(
      <ScreenStage stream={makeStream()} muted={false} sharedAudioVolume={0} />
    );

    expect(getVisibleVideo(container).volume).toBe(0);
  });

  it('applies a stored receive volume when an empty stage starts showing a remote share', () => {
    const rendered = render(<ScreenStage sharedAudioVolume={0.4} />);

    rendered.rerender(
      <ScreenStage stream={makeStream()} muted={false} sharedAudioVolume={0.4} />
    );

    expect(getVisibleVideo(rendered.container).volume).toBe(0.4);
  });

  it('keeps the local stream preview muted regardless of the stored receive volume', () => {
    const { container } = render(
      <ScreenStage stream={makeStream()} sharedAudioVolume={0.4} />
    );

    expect(getVisibleVideo(container).muted).toBe(true);
  });
});
