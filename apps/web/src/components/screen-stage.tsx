import { useEffect, useRef } from 'react';
import type { LiveKitTrackAdapter } from '../meeting/room-controller.js';

export function ScreenStage({
  stream,
  track,
  sharerName
}: {
  stream?: MediaStream;
  track?: Pick<LiveKitTrackAdapter, 'attach' | 'detach'>;
  sharerName?: string;
}) {
  const stageRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (track) {
      track.attach(video);
      return () => { track.detach(video); };
    }
    video.srcObject = stream ?? null;
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream, track]);

  if (!stream && !track) return <section className="screen-stage screen-stage-empty" aria-label="Shared screen stage">
    <p>No screen is being shared.</p>
  </section>;

  return <section ref={stageRef} className="screen-stage" aria-label="Shared screen stage">
    <video
      ref={videoRef}
      aria-label={`${sharerName ?? 'Participant'}'s shared screen`}
      autoPlay
      muted
      playsInline
      style={{ objectFit: 'contain' }}
    />
    <button
      type="button"
      className="screen-stage-fullscreen"
      aria-label="View shared screen fullscreen"
      onClick={() => { void stageRef.current?.requestFullscreen().catch(() => undefined); }}
    >Full screen</button>
  </section>;
}
