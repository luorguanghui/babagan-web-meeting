import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
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

    // The old stream stays on the visible video; the track is staged on a hidden probe.
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

  it('respects an explicit muted prop for remote P2P audio', () => {
    const stream = makeStream();
    const { container } = render(<ScreenStage stream={stream} muted={false} />);
    const video = getVisibleVideo(container);

    expect(video.muted).toBe(false);
  });
});
