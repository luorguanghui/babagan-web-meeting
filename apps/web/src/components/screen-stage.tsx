import { type ReactNode, useEffect, useRef } from 'react';
import { useI18n } from '../i18n/i18n.js';
import type { LiveKitTrackAdapter } from '../meeting/room-controller.js';

export function ScreenStage({
  stream,
  track,
  audioTrack,
  sharerName,
  children
}: {
  stream?: MediaStream;
  track?: Pick<LiveKitTrackAdapter, 'attach' | 'detach'>;
  audioTrack?: Pick<LiveKitTrackAdapter, 'attach' | 'detach'>;
  sharerName?: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
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
