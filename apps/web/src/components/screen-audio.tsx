import { useEffect, useRef, useState } from 'react';
import type { LiveKitTrackAdapter } from '../meeting/room-controller.js';
import { useI18n } from '../i18n/i18n.js';

/** Native audio-only playback survives Android's background video suspension. */
export function ScreenAudio({ stream, track, muted, volume }: {
  stream?: MediaStream;
  track?: Pick<LiveKitTrackAdapter, 'attach' | 'detach'>;
  muted: boolean;
  volume: number;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  const { t } = useI18n();
  useEffect(() => { if (ref.current) ref.current.volume = Math.min(1, Math.max(0, volume)); }, [volume]);
  useEffect(() => {
    const element = ref.current;
    setBlocked(false);
    if (!element || muted) return;
    let active = true;
    let attempt = 0;
    const play = () => {
      if (!active) return;
      const current = ++attempt;
      void element.play()?.then(() => { if (active && current === attempt) setBlocked(false); }, () => { if (active && current === attempt) setBlocked(true); });
    };
    let attached: MediaStreamTrack[] = [];
    const sync = () => {
      const tracks = stream?.getAudioTracks?.() ?? [];
      if (tracks.length === attached.length && tracks.every((item, i) => item === attached[i])) return;
      attached = tracks;
      // Share existing tracks without new capture, negotiation, or WebAudio.
      element.srcObject = tracks.length ? new MediaStream(tracks) : null;
      if (tracks.length) play();
    };
    if (track) { track.attach(element); play(); }
    else sync();
    stream?.addEventListener?.('addtrack', sync);
    stream?.addEventListener?.('removetrack', sync);
    const resume = () => { if (track || attached.length) play(); };
    const visible = () => { if (document.visibilityState === 'visible') resume(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pageshow', resume);
    window.addEventListener('babagan-resume-media', resume);
    return () => {
      active = false;
      stream?.removeEventListener?.('addtrack', sync);
      stream?.removeEventListener?.('removetrack', sync);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('babagan-resume-media', resume);
      track?.detach(element);
      element.srcObject = null;
    };
  }, [stream, track, muted]);
  return <><audio ref={ref} autoPlay hidden muted={muted} data-meeting-screen-audio />
    {blocked && !muted && <button type="button" className="screen-stage-display-message" onClick={() => window.dispatchEvent(new Event('babagan-resume-media'))}>{t('controls.resumeAudio')}</button>}
  </>;
}
