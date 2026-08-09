import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/i18n.js';
import type { LiveKitTrackAdapter } from '../meeting/room-controller.js';

export function ScreenStage({
  stream,
  track,
  audioTrack,
  sharerName
}: {
  stream?: MediaStream;
  track?: Pick<LiveKitTrackAdapter, 'attach' | 'detach'>;
  audioTrack?: Pick<LiveKitTrackAdapter, 'attach' | 'detach'>;
  sharerName?: string;
}) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const update = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', update);
    update();
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (track) {
      track.attach(video);
      audioTrack?.attach(video);
      return () => {
        audioTrack?.detach(video);
        track.detach(video);
      };
    }
    video.srcObject = stream ?? null;
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [audioTrack, stream, track]);

  if (!stream && !track) return <section className="screen-stage screen-stage-empty" aria-label={t('screen.stage')}>
    <p>{t('screen.empty')}</p>
  </section>;

  const name = sharerName ?? t('screen.participant');
  return <section ref={stageRef} className="screen-stage" aria-label={t('screen.stage')}>
    <video
      ref={videoRef}
      aria-label={t('screen.videoLabel', { name })}
      autoPlay
      muted={Boolean(stream) || !audioTrack}
      playsInline
      style={{ objectFit: 'contain' }}
    />
    {!isFullscreen && <button
      type="button"
      className="screen-stage-fullscreen"
      aria-label={t('screen.fullscreen')}
      title={t('screen.fullscreen')}
      onClick={() => { void stageRef.current?.requestFullscreen().catch(() => undefined); }}
    ><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 3H3v5h2V5h3V3Zm8 0v2h3v3h2V3h-5ZM5 16H3v5h5v-2H5v-3Zm16 0h-2v3h-3v2h5v-5Z" /></svg></button>}
  </section>;
}
