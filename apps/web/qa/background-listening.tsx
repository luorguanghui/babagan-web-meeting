/** Local-only QA. Generated tone and canvas, no microphone/camera/network. */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ScreenStage } from '../src/components/screen-stage.js';
import { useMeetingExitGuard } from '../src/meeting/use-meeting-exit-guard.js';
import { useMeetingMediaSession } from '../src/meeting/use-meeting-media-session.js';
import '../src/styles.css';

function Preview() {
  const [stream, setStream] = useState<MediaStream>();
  const [hidden, setHidden] = useState(0);
  const release = useRef<() => void>(() => {});
  const stop = () => {release.current();setStream(undefined);};
  useMeetingExitGuard(Boolean(stream));
  useMeetingMediaSession(Boolean(stream),'Background audio QA',stop);
  useEffect(()=>{
    const changed=()=>{if(document.hidden)setHidden(n=>n+1);};
    document.addEventListener('visibilitychange',changed);
    return()=>{document.removeEventListener('visibilitychange',changed);release.current();};
  },[]);
  const start=async()=>{
    const context=new AudioContext();await context.resume();
    const oscillator=context.createOscillator(), gain=context.createGain(), destination=context.createMediaStreamDestination();
    oscillator.frequency.value=220;gain.gain.value=0.04;
    oscillator.connect(gain).connect(destination);oscillator.start();
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const drawing=canvas.getContext('2d')!;drawing.fillStyle='#304330';drawing.fillRect(0,0,640,360);
    drawing.fillStyle='#fff';drawing.font='24px sans-serif';drawing.fillText('Generated media · no capture',40,180);
    const video=canvas.captureStream(5);const media=new MediaStream([...video.getVideoTracks(),...destination.stream.getAudioTracks()]);
    release.current=()=>{media.getTracks().forEach(t=>t.stop());oscillator.stop();void context.close();};
    setStream(media);
  };
  return <main style={{padding:24,maxWidth:760,margin:'auto'}}>
    <h1>Background audio regression</h1><p>Generated quiet tone; no microphone, camera, or meeting connection.</p>
    <p>Background transitions: <output>{hidden}</output></p>
    <button onClick={()=>void start()} disabled={Boolean(stream)}>Start test audio</button>{' '}
    <button onClick={stop} disabled={!stream}>Leave test meeting</button>{' '}
    <a href="/qa/panels.html">Leave page</a>
    <ScreenStage stream={stream} muted={false} independentAudio sharerName="QA generated source" />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
