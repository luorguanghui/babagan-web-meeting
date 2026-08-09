import { useCallback, useEffect, useRef, useState } from 'react';
import { type MessageKey, useI18n } from '../i18n/i18n.js';

interface DeviceCheckProps { onCleanupReady: (cleanup: (() => void) | null) => void; }

export function DeviceCheck({ onCleanupReady }: DeviceCheckProps) {
  const { t } = useI18n();
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const contextRef = useRef<AudioContext | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const [message, setMessage] = useState<{ key: MessageKey; isError: boolean }>({ key: 'device.off', isError: false });
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
      setMessage({ key: 'device.unavailable', isError: true });
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
      streamRef.current = stream; setMessage({ key: 'device.ready', isError: false }); startMeter(stream);
    }
    catch (reason) { setMessage(reason instanceof DOMException && reason.name === 'NotAllowedError' ? { key: 'device.denied', isError: true } : { key: 'device.failed', isError: true }); }
  }
  async function testSpeaker() {
    if (!window.AudioContext) return setMessage({ key: 'device.speakerUnavailable', isError: true });
    const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain();
    gain.gain.setValueAtTime(0.03, context.currentTime); oscillator.frequency.setValueAtTime(660, context.currentTime);
    oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.18);
    oscillator.addEventListener('ended', () => void context.close()); setMessage({ key: 'device.playing', isError: false });
  }
  return <section className="device-check" aria-labelledby="device-heading"><h2 id="device-heading">{t('device.heading')}</h2><p>{t('device.description')}</p><div className="device-actions"><button type="button" className="secondary" onClick={() => void checkMicrophone()}>{t('device.checkMicrophone')}</button><button type="button" className="text-button" onClick={() => void testSpeaker()}>{t('device.testSpeaker')}</button></div><label className="meter-label">{t('device.level')}<meter min="0" max="100" value={level}>{level}%</meter></label><p className={`message ${message.isError ? 'error' : ''}`} role={message.isError ? 'alert' : 'status'}>{t(message.key)}</p></section>;
}
