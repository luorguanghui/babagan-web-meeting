import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize, Minimize, MonitorUp, PictureInPicture2 } from 'lucide-react';
import { useI18n } from '../i18n/i18n.js';
import type { LiveKitTrackAdapter } from '../meeting/room-controller.js';
import { keepTrackVisibleInPictureInPicture, openScreenPictureInPicture, ScreenPictureInPictureError, type ScreenPictureInPictureSession } from './screen-picture-in-picture.js';
import './screen-stage.css';

type StageTrack = Pick<LiveKitTrackAdapter, 'attach' | 'detach'>;

type StageSource =
  | { kind: 'stream'; stream: MediaStream }
  | { kind: 'track'; track: StageTrack; audioTrack?: StageTrack }
  | null;

const LIVEKIT_HANDOVER_TIMEOUT_MS = 10_000;

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
  pipAllowed = false,
  shareIdentity,
  sourcePending = false,
  onSourceReady,
  sharedAudioVolume = 1,
  children
}: {
  stream?: MediaStream;
  track?: Pick<LiveKitTrackAdapter, 'attach' | 'detach'>;
  audioTrack?: Pick<LiveKitTrackAdapter, 'attach' | 'detach'>;
  /** Forces the element's muted state; defaults to muting local streams without remote audio. */
  muted?: boolean;
  sharerName?: string;
  /** Only remote receivers may open a system picture-in-picture window. */
  pipAllowed?: boolean;
  /** Stable sharer identity, independent of transport hops. Changing it closes PiP. */
  shareIdentity?: string;
  /** The transport is connected but its first frame has not been confirmed. */
  sourcePending?: boolean;
  /** Called after the selected source renders its first media event or a bounded LiveKit handover is forced. */
  onSourceReady?: () => void;
  /** Receiver-controlled shared-audio volume from 0 (muted) to 1 (original level). */
  sharedAudioVolume?: number;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const committedRef = useRef<StageSource>(null);
  const pendingSourceRef = useRef<StageSource>(null);
  const mediaHomeRef = useRef<HTMLDivElement>(null);
  const mediaHostRef = useRef<HTMLDivElement>(null);
  const pipSessionRef = useRef<ScreenPictureInPictureSession | null>(null);
  const pipVisibilityRef = useRef(new Map<StageTrack, () => void>());
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const [pipKind, setPipKind] = useState<'document' | 'video' | null>(null);
  const [pipBusy, setPipBusy] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [displayMessage, setDisplayMessage] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const hasSource = Boolean(stream || track);
  const name = sharerName?.trim() || t('screen.participant');
  const labels = {
    name, sharing: sourcePending ? `${name} · ${t('screen.receiving')}` : t('room.sharingBy', { name }), close: t('screen.pipClose'),
    returnToMeeting: t('screen.pipReturn'), audio: t('screen.pipAudio')
  };
  const syncPipVisibility = useCallback(() => {
    const desiredTracks = new Set<StageTrack>();
    if (pipSessionRef.current && videoElementRef.current) {
      for (const source of [committedRef.current, pendingSourceRef.current]) {
        if (source?.kind === 'track') desiredTracks.add(source.track);
      }
    }
    for (const [sourceTrack, release] of pipVisibilityRef.current) {
      if (!desiredTracks.has(sourceTrack)) { release(); pipVisibilityRef.current.delete(sourceTrack); }
    }
    for (const sourceTrack of desiredTracks) {
      if (!pipVisibilityRef.current.has(sourceTrack)) {
        pipVisibilityRef.current.set(sourceTrack, keepTrackVisibleInPictureInPicture(sourceTrack, videoElementRef.current!));
      }
    }
  }, []);
  const closePip = useCallback(async (discard = false): Promise<boolean> => {
    const session = pipSessionRef.current;
    // Invalidate unfinished opens, and discard obsolete sessions on end/unmount.
    // For an ordinary close, retain the active state until the browser confirms it.
    if (discard || !session) {
      requestGenerationRef.current += 1;
      pipSessionRef.current = null;
      syncPipVisibility();
      if (mountedRef.current) { setPipKind(null); setPipBusy(false); }
    } else if (mountedRef.current) setPipBusy(true);
    if (!session) return true;
    try {
      await session.close();
      if (pipSessionRef.current === session) {
        pipSessionRef.current = null;
        syncPipVisibility();
        if (mountedRef.current) setPipKind(null);
      }
      return true;
    } catch {
      if (mountedRef.current && !discard) setDisplayMessage(t('screen.pipCloseFailed'));
      return false;
    } finally {
      if (mountedRef.current) setPipBusy(false);
    }
  }, [syncPipVisibility, t]);
  // Keep the media host mounted even for the empty state so React never tries
  // to remove a node from its old parent while that node is in another document.
  useLayoutEffect(() => {
    return () => { void closePip(true); };
  }, [hasSource, pipAllowed, shareIdentity, closePip]);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    return () => {
      if (stage && document.fullscreenElement === stage) void document.exitFullscreen?.().catch(() => undefined);
    };
  }, [hasSource, shareIdentity]);
  useEffect(() => { pipSessionRef.current?.updateLabels(labels); });
  const togglePip = async () => {
    if (pipSessionRef.current) { await closePip(); return; }
    const video = videoRef.current;
    const home = mediaHomeRef.current;
    const mediaHost = mediaHostRef.current;
    if (!pipAllowed || sourcePending || !video || !home || !mediaHost || pipBusy) return;
    const request = ++requestGenerationRef.current;
    setPipBusy(true);
    setDisplayMessage(null);
    try {
      const session = await openScreenPictureInPicture({
        video, home, mediaHost, labels,
        onClose: () => {
          if (request !== requestGenerationRef.current) return;
          pipSessionRef.current = null;
          syncPipVisibility();
          if (mountedRef.current) { setPipKind(null); setPipBusy(false); setDisplayMessage(null); }
        }
      });
      if (request !== requestGenerationRef.current || !mountedRef.current) { await session.close(); return; }
      pipSessionRef.current = session;
      syncPipVisibility();
      setPipKind(session.kind);
    } catch (error) {
      if (request !== requestGenerationRef.current || !mountedRef.current) return;
      const reason = error instanceof ScreenPictureInPictureError ? error.reason : 'failed';
      setDisplayMessage(t(reason === 'unsupported' ? 'screen.pipUnsupported' : reason === 'denied' ? 'screen.pipDenied' : 'screen.pipFailed'));
    } finally {
      if (request === requestGenerationRef.current && mountedRef.current) setPipBusy(false);
    }
  };
  useEffect(() => {
    const changed = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  const toggleFullscreen = async () => {
    setDisplayMessage(null);
    try {
      if (document.fullscreenElement === stageRef.current) await document.exitFullscreen();
      else {
        if (!await closePip()) return;
        if (!stageRef.current?.requestFullscreen) throw new Error('Fullscreen unavailable');
        await stageRef.current.requestFullscreen();
      }
    } catch { setDisplayMessage(t('screen.fullscreenFailed')); }
  };
  const [sourceAspectRatio, setSourceAspectRatio] = useState(16 / 9);
  const updateAspectRatio = useCallback(() => {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) return;
    setSourceAspectRatio(video.videoWidth / video.videoHeight);
    setDimensions({ width: video.videoWidth, height: video.videoHeight });
  }, []);

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
      setSourceAspectRatio(16 / 9);
      setDimensions(null);
      setDisplayMessage(null);
      syncPipVisibility();
      if (element !== null && committed !== null) releaseSource(element, committed);
      return;
    }

    if (committed === null) {
      // First source: apply directly.
      if (element === null) return;
      applySource(element, desired);
      committedRef.current = desired;
      syncPipVisibility();
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
    // probe (transparent and renderable for LiveKit, hidden for direct streams)
    // and keep the old source visible until the new one actually renders a
    // frame, avoiding a black screen during P2P <-> LiveKit hops.
    let probe: HTMLVideoElement | undefined;
    const releaseProbe = () => {
      if (probe === undefined) return;
      if (desired.kind === 'track') {
        desired.track.detach(probe);
      }
      probe.srcObject = null;
      probe.remove();
      probe = undefined;
    };
    let handoverTimer: ReturnType<typeof setTimeout> | undefined;
    const commit = () => {
      if (probe === undefined) return;
      if (handoverTimer !== undefined) {
        clearTimeout(handoverTimer);
        handoverTimer = undefined;
      }
      releaseProbe();
      pendingSourceRef.current = null;
      setDimensions(null);
      applySource(element, desired);
      const previous = committedRef.current;
      committedRef.current = desired;
      if (previous !== null && !sameSource(previous, desired) && previous.kind === 'track') {
        releaseSource(element, previous);
      }
      syncPipVisibility();
      onSourceReady?.();
    };

    pendingSourceRef.current = desired;
    syncPipVisibility();
    probe = element.ownerDocument.createElement('video');
    probe.muted = true;
    probe.autoplay = true;
    probe.playsInline = true;
    probe.setAttribute('data-stage-probe', 'true');
    if (desired.kind === 'track') {
      // LiveKit adaptiveStream only sends video while at least one attached
      // element is visible. A `hidden` probe therefore deadlocks a TURN/P2P →
      // SFU handover: the first frame is required to commit the switch, while
      // adaptiveStream withholds that frame because the probe is invisible.
      // Keep the probe in the viewport and transparent instead. It remains
      // non-interactive and inaccessible, but LiveKit can request the stream.
      probe.setAttribute('aria-hidden', 'true');
      probe.tabIndex = -1;
      probe.style.position = 'fixed';
      probe.style.left = '0';
      probe.style.top = '0';
      probe.style.width = `${Math.max(element.clientWidth, 1)}px`;
      probe.style.height = `${Math.max(element.clientHeight, 1)}px`;
      probe.style.opacity = '0';
      probe.style.pointerEvents = 'none';
    } else {
      probe.hidden = true;
    }
    // Keep a pending probe with the same host when PiP opens or closes.
    (element.parentElement ?? element.ownerDocument.body).append(probe);
    // The probe only needs a video frame. Never give it an audio attachment:
    // a LiveKit WebAudio configuration can play audio independently of muted.
    if (desired.kind === 'track') desired.track.attach(probe);
    else applySource(probe, desired);
    const firstFrame = () => commit();
    probe.addEventListener('loadedmetadata', firstFrame, { once: true });
    probe.addEventListener('playing', firstFrame, { once: true });
    if (desired.kind === 'track') {
      // A missing media event must not retain a dead TURN/P2P frame forever.
      // Forcing the LiveKit track onto the visible element also gives
      // adaptiveStream an unquestionably visible attachment from which it can
      // recover after a missed visibility/subscription transition.
      handoverTimer = setTimeout(commit, LIVEKIT_HANDOVER_TIMEOUT_MS);
    }

    return () => {
      if (handoverTimer !== undefined) clearTimeout(handoverTimer);
      probe?.removeEventListener('loadedmetadata', firstFrame);
      probe?.removeEventListener('playing', firstFrame);
      releaseProbe();
      pendingSourceRef.current = null;
      syncPipVisibility();
    };
  }, [audioTrack, onSourceReady, stream, track, syncPipVisibility]);

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

  useEffect(() => {
    const element = videoRef.current;
    if (element !== null) element.volume = Math.min(1, Math.max(0, sharedAudioVolume));
  }, [audioTrack, sharedAudioVolume, stream, track]);

  useEffect(() => {
    const video = videoRef.current;
    // React delegates events to its opener root, which is not an ancestor of a
    // video moved into Document PiP. Native listeners follow the same element.
    video?.addEventListener('loadedmetadata', updateAspectRatio);
    video?.addEventListener('resize', updateAspectRatio);
    return () => {
      video?.removeEventListener('loadedmetadata', updateAspectRatio);
      video?.removeEventListener('resize', updateAspectRatio);
    };
  }, [hasSource, updateAspectRatio]);

  const stageStyle = { '--stage-aspect-ratio': String(sourceAspectRatio) } as CSSProperties;
  return <section
    ref={stageRef}
    className={`screen-stage${hasSource ? '' : ' screen-stage-empty'}`}
    aria-label={t('screen.stage')}
    data-orientation={sourceAspectRatio >= 1 ? 'landscape' : 'portrait'}
    data-pip={pipKind ?? undefined}
    style={stageStyle}
  >
    {hasSource && <header className="screen-stage-header">
      <div className="screen-stage-sharer">
        <span className="screen-stage-avatar" aria-hidden="true">{[...name][0]}</span>
        <span>{labels.sharing}</span>
      </div>
      <div className="screen-stage-actions">
        {dimensions && <span className="screen-stage-resolution">{dimensions.width} × {dimensions.height}</span>}
        {pipAllowed && <button type="button" className="screen-stage-pip" aria-label={pipKind ? t('screen.pipReturn') : t('screen.pip')} title={pipKind ? t('screen.pipReturn') : t('screen.pip')} aria-pressed={Boolean(pipKind)} disabled={pipBusy || (sourcePending && !pipKind)} onClick={() => { void togglePip(); }}>
          <PictureInPicture2 size={16} aria-hidden="true" /><span>{pipKind ? t('screen.pipReturn') : t('screen.pip')}</span>
        </button>}
        <button type="button" className="screen-stage-fullscreen" aria-label={isFullscreen ? t('screen.exitFullscreen') : t('screen.fullscreen')} title={isFullscreen ? t('screen.exitFullscreen') : t('screen.fullscreen')} onClick={() => { void toggleFullscreen(); }}>
          {isFullscreen ? <Minimize size={16} aria-hidden="true" /> : <Maximize size={16} aria-hidden="true" />}<span>{isFullscreen ? t('screen.exitFullscreen') : t('screen.fullscreenAction')}</span>
        </button>
      </div>
    </header>}
    {!hasSource && <div className="screen-empty-content">
      <span className="screen-empty-icon"><MonitorUp aria-hidden="true" size={28} /></span>
      <h2>{t('screen.emptyTitle')}</h2>
      <p>{t('screen.empty')}</p>
      <p className="screen-empty-hint">{t('screen.emptyHint')}</p>
    </div>}
    <div className="screen-stage-media-home" ref={mediaHomeRef} hidden={!hasSource}>
      <div className="screen-stage-media" ref={mediaHostRef}>
        {hasSource && <video
          ref={videoRef}
          aria-label={t('screen.videoLabel', { name })}
          autoPlay
          muted={muted ?? (Boolean(stream) || !audioTrack)}
          playsInline
          style={{ objectFit: 'contain' }}
        />}
      </div>
      {pipKind === 'document' && <div className="screen-stage-pip-placeholder">
        <PictureInPicture2 size={36} aria-hidden="true" />
        <p>{t('screen.pipActive')}</p>
      </div>}
    </div>
    {displayMessage && <p className="screen-stage-display-message" role="status">{displayMessage}</p>}
    {hasSource && children}
  </section>;
}
