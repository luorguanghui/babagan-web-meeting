import { captureAborted } from '../meeting/capture-abort.js';
import { registerNativeCaptureTrack } from '../meeting/native-capture.js';
import { ClientHostError, type ClientHost } from './host-bridge.js';

interface CaptureFormat { width: number; height: number; frameRate: number; }
export type SystemAudioUnavailableReason = 'permission-denied' | 'unsupported' | 'unavailable';
interface StartResult extends CaptureFormat { sessionId: string; offer: RTCSessionDescriptionInit; systemAudio?: boolean; systemAudioExcludesOwnApp?: boolean; systemAudioReason?: SystemAudioUnavailableReason; }
const verifiedPlaybackAudio = new WeakSet<MediaStreamTrack>();
/** Only this module can register a track, after its native session confirms own-UID exclusion. */
export function isAndroidPlaybackAudioTrack(track: MediaStreamTrack): boolean {
  return verifiedPlaybackAudio.has(track) && track.kind === 'audio' && track.readyState === 'live';
}
interface AndroidCaptureDependencies {
  signal?: AbortSignal;
  createPeer?: () => RTCPeerConnection;
  createStream?: (track: MediaStreamTrack) => MediaStream;
  sessionId?: string;
  lifecycle?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  negotiationTimeoutMs?: number;
  /** Use 30 for a client that did not advertise the v0.1.2 capture capability. */
  maxFrameRate?: 30 | 60;
  onSystemAudioUnavailable?: (reason: SystemAudioUnavailableReason) => void;
}
function format(value: unknown): CaptureFormat | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as CaptureFormat;
  if (!Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width < 2 || v.height < 2 || v.width > 4096 || v.height > 4096
    || !Number.isFinite(v.frameRate) || v.frameRate <= 0 || v.frameRate > 60) return;
  return { width: v.width, height: v.height, frameRate: v.frameRate };
}
function candidate(value: unknown): value is RTCIceCandidateInit | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const c = value as RTCIceCandidateInit;
  return typeof c.candidate === 'string' && c.candidate.length <= 8192
    && (c.sdpMid == null || typeof c.sdpMid === 'string')
    && (c.sdpMLineIndex == null || (Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0));
}
function requestedRate(constraints: DisplayMediaStreamOptions): 30 | 60 {
  const rate = typeof constraints.video === 'object' ? constraints.video.frameRate : undefined;
  const value = typeof rate === 'number' ? rate : rate?.exact ?? Math.min(rate?.ideal ?? rate?.max ?? 30, rate?.max ?? 60);
  return value >= 60 ? 60 : 30;
}

/** Native MediaProjection feeds a local WebRTC receiver; publication uses the existing stream paths. */
export function captureAndroidScreen(host: ClientHost, constraints: DisplayMediaStreamOptions, deps: AndroidCaptureDependencies = {}): Promise<MediaStream> {
  if (host.platform !== 'android') return Promise.reject(new ClientHostError('unsupported', 'Android capture requires the Android client.'));
  if (deps.signal?.aborted) return Promise.reject(captureAborted());
  const sessionId = deps.sessionId ?? crypto.randomUUID();
  const frameRate = Math.min(requestedRate(constraints), deps.maxFrameRate ?? 30) as 30 | 60;
  const lifecycle = deps.lifecycle ?? window;
  const requestedAudio = !!constraints.audio;
  return new Promise<MediaStream>((resolve, reject) => {
    let peer: RTCPeerConnection | undefined;
    let closed = false, remoteReady = false, negotiated = false, resolved = false, started = false;
    let capturedTrack: MediaStreamTrack | undefined, originalStop: (() => void) | undefined;
    let audioTrack: MediaStreamTrack | undefined, stream: MediaStream | undefined;
    let expectedAudio = false, audioUnavailable = false;
    let activeFormat: CaptureFormat | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const queuedCandidates: Array<RTCIceCandidateInit | null> = [];
    let iceTail = Promise.resolve();
    const requestAbort = new AbortController();
    let unsubscribe = () => {};
    const stopHost = () => { if (started) void host.request('capture.stop', { sessionId }, { timeoutMs: 5000 }).catch(() => undefined); };
    const cleanup = (error: Error = captureAborted(), signalEnded = true) => {
      if (closed) return;
      closed = true; clearTimeout(timer); requestAbort.abort();
      deps.signal?.removeEventListener('abort', abort); lifecycle.removeEventListener('pagehide', abort);
      unsubscribe(); queuedCandidates.length = 0;
      capturedTrack?.removeEventListener('ended', onTrackEnded);
      if (audioTrack) { verifiedPlaybackAudio.delete(audioTrack); audioTrack.removeEventListener('ended', onAudioEnded); audioTrack.stop(); }
      stopHost(); peer?.close(); originalStop?.();
      if (!resolved) reject(error);
      else if (signalEnded) capturedTrack?.dispatchEvent(new Event('ended'));
    };
    const abort = () => cleanup(captureAborted());
    const onTrackEnded = () => cleanup(new ClientHostError('capture-ended', 'Screen capture ended.'), false);
    const loseAudio = (reason: SystemAudioUnavailableReason) => {
      expectedAudio = false;
      if (audioTrack) {
        verifiedPlaybackAudio.delete(audioTrack);
        audioTrack.removeEventListener('ended', onAudioEnded); audioTrack.stop(); stream?.removeTrack(audioTrack); audioTrack = undefined;
      }
      if (requestedAudio && !audioUnavailable) { audioUnavailable = true; deps.onSystemAudioUnavailable?.(reason); }
      deliver();
    };
    const onAudioEnded = () => loseAudio('unavailable');
    const deliver = () => {
      if (closed || resolved || !negotiated || !capturedTrack || !activeFormat || (expectedAudio && !audioTrack)) return;
      if (capturedTrack.readyState === 'ended') { cleanup(new ClientHostError('capture-ended', 'Screen capture ended.')); return; }
      stream = (deps.createStream ?? (track => new MediaStream([track])))(capturedTrack);
      if (audioTrack) stream.addTrack(audioTrack);
      clearTimeout(timer); resolved = true; resolve(stream);
    };
    const addCandidate = (value: RTCIceCandidateInit | null) => {
      iceTail = iceTail.then(async () => { if (!closed) await peer!.addIceCandidate(value ?? undefined); }).catch(() => cleanup(new ClientHostError('capture-failed', 'The screen capture connection failed.')));
    };
    try {
      peer = (deps.createPeer ?? (() => new RTCPeerConnection({ iceServers: [] })))();
      peer.onicecandidate = event => {
        if (closed) return;
        void host.request('capture.signal', { sessionId, candidate: event.candidate?.toJSON() ?? null }, { signal: requestAbort.signal })
          .catch(error => { if (!closed) cleanup(error instanceof Error ? error : new ClientHostError('capture-failed', 'Screen signaling failed.')); });
      };
      peer.ontrack = event => {
        if (capturedTrack === event.track || audioTrack === event.track) return;
        if (!closed && event.track.kind === 'audio' && expectedAudio && !audioTrack) {
          if (event.track.readyState === 'ended') { loseAudio('unavailable'); return; }
          audioTrack = event.track; verifiedPlaybackAudio.add(audioTrack);
          audioTrack.addEventListener('ended', onAudioEnded, { once: true }); deliver(); return;
        }
        if (closed || event.track.kind !== 'video' || capturedTrack) { event.track.stop(); return; }
        capturedTrack = event.track; originalStop = capturedTrack.stop.bind(capturedTrack);
        const getSettings = capturedTrack.getSettings.bind(capturedTrack);
        capturedTrack.getSettings = () => ({ ...getSettings(), ...activeFormat, aspectRatio: activeFormat ? activeFormat.width / activeFormat.height : undefined, displaySurface: 'monitor' });
        registerNativeCaptureTrack(capturedTrack);
        capturedTrack.stop = () => cleanup(captureAborted(), false);
        capturedTrack.addEventListener('ended', onTrackEnded, { once: true });
        deliver();
      };
      peer.onconnectionstatechange = () => {
        if (!closed && (peer!.connectionState === 'failed' || peer!.connectionState === 'closed')) cleanup(new ClientHostError('capture-ended', 'The screen capture connection ended.'));
      };
      unsubscribe = host.subscribe(event => {
        if (closed || event.sessionId !== sessionId) return;
        if (event.event === 'capture.ended') cleanup(new ClientHostError('capture-ended', typeof event.reason === 'string' ? event.reason : 'Screen capture ended.'));
        else if (event.event === 'capture.audio-ended') loseAudio('unavailable');
        else if (event.event === 'capture.resized' && activeFormat) {
          const resized = format({ width: event.width, height: event.height, frameRate: event.frameRate ?? activeFormat.frameRate });
          if (resized && resized.frameRate === frameRate) activeFormat = resized;
        } else if (event.event === 'capture.signal' && candidate(event.candidate)) {
          if (remoteReady) addCandidate(event.candidate);
          else if (queuedCandidates.length < 128) queuedCandidates.push(event.candidate);
          else cleanup(new ClientHostError('protocol', 'Too many queued screen candidates.'));
        }
      });
      deps.signal?.addEventListener('abort', abort, { once: true }); lifecycle.addEventListener('pagehide', abort);
      if (deps.signal?.aborted) { abort(); return; }
      started = true;
      void host.request<StartResult>('capture.start', { sessionId, width: 1920, height: 1080, frameRate, audio: requestedAudio }, { timeoutMs: 120_000, signal: requestAbort.signal })
        .then(async result => {
          if (closed) { stopHost(); return; }
          const receivedFormat = format(result);
          if (!receivedFormat || result.sessionId !== sessionId || result.offer?.type !== 'offer' || typeof result.offer.sdp !== 'string' || result.offer.sdp.length > 200_000) throw new ClientHostError('protocol', 'Invalid screen capture offer.');
          if (receivedFormat.frameRate !== frameRate) throw new ClientHostError('protocol', 'Native capture did not configure the selected frame rate.');
          activeFormat = receivedFormat;
          expectedAudio = requestedAudio && result.systemAudio === true && result.systemAudioExcludesOwnApp === true && !audioUnavailable;
          if (requestedAudio && !expectedAudio) loseAudio(result.systemAudioReason === 'permission-denied' || result.systemAudioReason === 'unsupported' ? result.systemAudioReason : 'unavailable');
          timer = setTimeout(() => {
            if (negotiated && capturedTrack?.readyState !== 'ended' && capturedTrack && expectedAudio) loseAudio('unavailable');
            else cleanup(new ClientHostError('timeout', 'The screen capture connection timed out.'));
          }, deps.negotiationTimeoutMs ?? 20_000);
          await peer!.setRemoteDescription(result.offer);
          if (closed) return;
          remoteReady = true; for (const value of queuedCandidates.splice(0)) addCandidate(value);
          await iceTail; if (closed) return;
          const answer = await peer!.createAnswer(); if (closed) return;
          await peer!.setLocalDescription(answer); if (closed) return;
          await host.request('capture.signal', { sessionId, description: { type: 'answer', sdp: peer!.localDescription?.sdp ?? answer.sdp } }, { signal: requestAbort.signal });
          if (closed) return;
          negotiated = true; deliver();
        }).catch(error => { if (!closed) cleanup(error instanceof Error ? error : new ClientHostError('capture-failed', 'Screen capture failed.')); });
    } catch (error) { cleanup(error instanceof Error ? error : new ClientHostError('capture-failed', 'Screen capture failed.')); }
  });
}
