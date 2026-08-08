import { useEffect, useRef } from 'react';

export function ScreenStage({ stream, sharerName }: { stream?: MediaStream; sharerName?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream ?? null;
    return () => {
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [stream]);

  if (!stream) return <section className="screen-stage screen-stage-empty" aria-label="Shared screen stage">
    <p>No screen is being shared.</p>
  </section>;

  return <section className="screen-stage" aria-label="Shared screen stage">
    <video
      ref={videoRef}
      aria-label={`${sharerName ?? 'Participant'}'s shared screen`}
      autoPlay
      muted
      playsInline
      style={{ objectFit: 'contain' }}
    />
  </section>;
}
