import { useCallback, useEffect, useRef, useState } from 'react';

interface DeviceCheckProps { onCleanupReady: (cleanup: (() => void) | null) => void; }

export function DeviceCheck({ onCleanupReady }: DeviceCheckProps) {
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const contextRef = useRef<AudioContext | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const [message, setMessage] = useState({ text: 'Microphone is off until you check it.', isError: false });
  const [level, setLevel] = useState(0);
  const stopPreview = useCallback(() => {
    generationRef.current += 1;
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = undefined;
    void contextRef.current?.close(); contextRef.current = undefined;
    if (mountedRef.current) setLevel(0);
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    onCleanupReady(stopPreview);
    return () => { mountedRef.current = false; onCleanupReady(null); stopPreview(); };
  }, [onCleanupReady, stopPreview]);

  function startMeter(stream: MediaStream) {
    if (!window.AudioContext) return;
    const context = new AudioContext(); contextRef.current = context;
    const analyser = context.createAnalyser(); analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const measure = () => {
      analyser.getByteTimeDomainData(samples);
      const average = samples.reduce((total, sample) => total + Math.abs(sample - 128), 0) / samples.length;
      setLevel(Math.min(100, Math.round(average * 2)));
      frameRef.current = requestAnimationFrame(measure);
    };
    measure();
  }
  async function checkMicrophone() {
    stopPreview();
    const getUserMedia = navigator.mediaDevices?.getUserMedia;
    if (!getUserMedia) {
      setMessage({ text: 'This browser or device policy does not expose microphone access. Use a current Windows Chrome or Edge browser and allow microphone access.', isError: true });
      return;
    }
    const requestGeneration = generationRef.current + 1;
    generationRef.current = requestGeneration;
    try {
      const stream = await getUserMedia.call(navigator.mediaDevices, { audio: true });
      if (!mountedRef.current || requestGeneration !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream; setMessage({ text: 'Microphone preview is ready.', isError: false }); startMeter(stream);
    }
    catch (reason) { setMessage(reason instanceof DOMException && reason.name === 'NotAllowedError' ? { text: 'Microphone permission was denied. Allow it in your browser settings and try again.', isError: true } : { text: 'Microphone preview could not start. Check your microphone and try again.', isError: true }); }
  }
  async function testSpeaker() {
    if (!window.AudioContext) return setMessage({ text: 'Speaker test is unavailable in this browser.', isError: true });
    const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain();
    gain.gain.setValueAtTime(0.03, context.currentTime); oscillator.frequency.setValueAtTime(660, context.currentTime);
    oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.18);
    oscillator.addEventListener('ended', () => void context.close()); setMessage({ text: 'Playing a short speaker test.', isError: false });
  }
  return <section className="device-check" aria-labelledby="device-heading"><h2 id="device-heading">Device check</h2><p>Checking your microphone is optional. It never starts before you choose it.</p><div className="device-actions"><button type="button" className="secondary" onClick={() => void checkMicrophone()}>Check microphone</button><button type="button" className="text-button" onClick={() => void testSpeaker()}>Test speaker</button></div><label className="meter-label">Microphone level<meter min="0" max="100" value={level}>{level}%</meter></label><p className={`message ${message.isError ? 'error' : ''}`} role={message.isError ? 'alert' : 'status'}>{message.text}</p></section>;
}
