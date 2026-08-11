import { type ReactNode, useEffect, useRef } from 'react';
import { useI18n } from '../i18n/i18n.js';
import type { LiveKitTrackAdapter } from '../meeting/room-controller.js';

type StageTrack = Pick<LiveKitTrackAdapter, 'attach' | 'detach'>;

type StageSource =
  | { kind: 'stream'; stream: MediaStream }
  | { kind: 'track'; track: StageTrack; audioTrack?: StageTrack }
  | null;

function sameSource(a: StageSource, b: StageSource): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.kind === 'stream' && b.kind === 'stream') return a.stream === b.stream;
  return a.kind === 'track' && b.kind === 'track' && a.track === b.track;
}

function applySource(element: HTMLMediaElement, source: StageSource): void {
  if (source === null) {
    element.srcObject = null;
    return;
  }
  if (source.kind === 'stream') {
    element.srcObject = source.stream;
    return;
  }
  source.track.attach(element);
  source.audioTrack?.attach(element);
}

/**
 * Releases a source from the element. Tracks are detached explicitly (LiveKit's
 * detach only clears the element when it still owns the stream, so detaching
 * after a swap is safe); streams are only cleared when the element still shows
 * them — an incoming source has already replaced them.
 */
function releaseSource(element: HTMLMediaElement, source: StageSource): void {
  if (source === null) return;
  if (source.kind === 'track') {
    source.audioTrack?.detach(element);
    source.track.detach(element);
  } else if (element.srcObject === source.stream) {
    element.srcObject = null;
  }
}

export function ScreenStage({
  stream,
  track,
  audioTrack,
  muted,
  sharerName,
  onSourceReady,
  children
}: {
  stream?: MediaStream;
  track?: Pick<LiveKitTrackAdapter, 'attach' | 'detach'>;
  audioTrack?: Pick<LiveKitTrackAdapter, 'attach' | 'detach'>;
  /** Forces the element's muted state; defaults to muting local streams without remote audio. */
  muted?: boolean;
  sharerName?: string;
  /** Called after the selected source has rendered its first browser media event. */
  onSourceReady?: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const committedRef = useRef<StageSource>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video !== null) videoElementRef.current = video;
    // The empty state unmounts the <video> element, so effect runs in the empty
    // state must release through the last known element instead of the nulled ref.
    const element = videoElementRef.current;
    const desired: StageSource = track
      ? { kind: 'track', track, audioTrack }
      : stream
        ? { kind: 'stream', stream }
        : null;
    const committed = committedRef.current;

    if (sameSource(committed, desired)) {
      if (committed?.kind === 'track' && committed.audioTrack !== audioTrack) {
        if (element !== null) {
          audioTrack?.attach(element);
          committed.audioTrack?.detach(element);
          committedRef.current = { ...committed, audioTrack };
        }
      }
      return;
    }

    if (desired === null) {
      // The share ended: release immediately, no first-frame retention for "nothing".
      committedRef.current = null;
      if (element !== null && committed !== null) releaseSource(element, committed);
      return;
    }

    if (committed === null) {
      // First source: apply directly.
      if (element === null) return;
      applySource(element, desired);
      committedRef.current = desired;
      let notified = false;
      const ready = () => {
        if (notified) return;
        notified = true;
        onSourceReady?.();
      };
      element.addEventListener('loadedmetadata', ready);
      element.addEventListener('playing', ready);
      return () => {
        element.removeEventListener('loadedmetadata', ready);
        element.removeEventListener('playing', ready);
      };
    }

    if (element === null) return; // no visible element to swap (empty stage)

    // Dual-source switch with first-frame retention: stage the new source on a
    // hidden probe element and keep the old source visible until the new one
    // actually renders a frame (loadedmetadata/playing), avoiding a black
    // screen longer than the browser's switch latency on P2P <-> LiveKit hops.
    let probe: HTMLVideoElement | undefined;
    const releaseProbe = () => {
      if (probe === undefined) return;
      if (desired.kind === 'track') {
        desired.track.detach(probe);
        desired.audioTrack?.detach(probe);
      }
      probe.srcObject = null;
      probe.remove();
      probe = undefined;
    };
    const commit = () => {
      if (probe === undefined) return;
      releaseProbe();
      applySource(element, desired);
      const previous = committedRef.current;
      committedRef.current = desired;
      if (previous !== null && !sameSource(previous, desired) && previous.kind === 'track') {
        releaseSource(element, previous);
      }
      onSourceReady?.();
    };

    probe = document.createElement('video');
    probe.muted = true;
    probe.autoplay = true;
    probe.playsInline = true;
    probe.setAttribute('data-stage-probe', 'true');
    probe.hidden = true;
    document.body.append(probe);
    applySource(probe, desired);
    const firstFrame = () => commit();
    probe.addEventListener('loadedmetadata', firstFrame, { once: true });
    probe.addEventListener('playing', firstFrame, { once: true });

    return () => {
      probe?.removeEventListener('loadedmetadata', firstFrame);
      probe?.removeEventListener('playing', firstFrame);
      releaseProbe();
    };
  }, [audioTrack, onSourceReady, stream, track]);

  useEffect(() => {
    // Unmount: release whatever the stage is showing. Empty deps mean this
    // cleanup runs only on unmount, so a props change never releases a source
    // that the next effect run is still staging behind its probe.
    return () => {
      const committed = committedRef.current;
      committedRef.current = null;
      const element = videoElementRef.current;
      if (element !== null && committed !== null) releaseSource(element, committed);
    };
  }, []);

  if (!stream && !track) return <section className="screen-stage screen-stage-empty" aria-label={t('screen.stage')}>
    <p>{t('screen.empty')}</p>
  </section>;

  const name = sharerName ?? t('screen.participant');
  return <section ref={stageRef} className="screen-stage" aria-label={t('screen.stage')}>
    <video
      ref={videoRef}
      aria-label={t('screen.videoLabel', { name })}
      autoPlay
      muted={muted ?? (Boolean(stream) || !audioTrack)}
      playsInline
      style={{ objectFit: 'contain' }}
    />
    <button
      type="button"
      className="screen-stage-fullscreen"
      aria-label={t('screen.fullscreen')}
      title={t('screen.fullscreen')}
      onClick={() => { void stageRef.current?.requestFullscreen().catch(() => undefined); }}
    >{t('screen.fullscreenAction')}</button>
    {children}
  </section>;
}
