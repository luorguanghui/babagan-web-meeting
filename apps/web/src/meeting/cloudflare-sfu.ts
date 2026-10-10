import { CloudflareSfuSessionResponseSchema, type CloudflareSfuPublication, type CloudflareSfuSessionResponse } from '@meeting/contracts';
import { apiNoContent, apiRequest } from '../api/client.js';
import type { ScreenSharePublishOptions } from './screen-share.js';
export interface CloudflareScreenApi {
  publish(body: unknown): Promise<CloudflareSfuSessionResponse>;
  ready(sessionId: string): Promise<void>;
  subscribe(shareId: string): Promise<CloudflareSfuSessionResponse>;
  answer(sessionId: string, answer: RTCSessionDescriptionInit): Promise<void>;
  close(sessionId: string): Promise<void>;
}
export class CloudflareScreenSession {
  private pc?: RTCPeerConnection;
  private sessionId?: string;
  private epoch = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();
  private readonly clones: MediaStreamTrack[] = [];
  private readonly remoteTracks = new Set<MediaStreamTrack>();
  private shown = false;
  constructor(private readonly deps: {
    api: CloudflareScreenApi;
    fetchIceServers(): Promise<RTCIceServer[]>;
    createPeerConnection?(ice: RTCIceServer[]): RTCPeerConnection;
    createMediaStream?(): MediaStream;
    onStream?(stream: MediaStream): void;
    onError?(error: Error): void;
  }) { }
  publish(stream: MediaStream, options: ScreenSharePublishOptions): Promise<void> {
    return this.negotiate(async (epoch) => {
      const pc = await this.create(epoch);
      if (!pc)
        return;
      const tracks = [stream.getVideoTracks()[0], stream.getAudioTracks()[0]].filter((t): t is MediaStreamTrack => Boolean(t));
      if (tracks.filter(t => t.kind === 'video').length !== 1)
        throw new Error('Cloudflare SFU requires one screen video track.');
      const transceivers = tracks.map(track => {
        const clone = track.clone();
        clone.contentHint = track.contentHint;
        this.clones.push(clone);
        const transceiver = pc.addTransceiver(clone, { direction: 'sendonly', sendEncodings: [{ maxBitrate: track.kind === 'video' ? options.maxBitrate : 128000, ...(track.kind === 'video' ? { maxFramerate: options.frameRate } : {}) }] });
        if (track.kind === 'video' && options.codec !== 'auto') {
          const codecs = globalThis.RTCRtpSender?.getCapabilities?.('video')?.codecs;
          const preferred = codecs?.filter(c => c.mimeType.toLowerCase() === `video/${options.codec}`);
          if (preferred?.length && transceiver.setCodecPreferences)
            transceiver.setCodecPreferences([...preferred, ...codecs!.filter(c => !preferred.includes(c))]);
        }
        return { track, transceiver };
      });
      await pc.setLocalDescription(await pc.createOffer());
      await waitForPc(pc, 'icegatheringstatechange', () => pc.iceGatheringState === 'complete', this.abort.signal, 8000);
      if (!this.current(epoch))
        return;
      const allocation = await this.deps.api.publish({ sessionDescription: description(pc, 'offer'), tracks: transceivers.map(({ track, transceiver }) => {
          if (transceiver.mid === null)
            throw new Error('Cloudflare SFU offer has no media MID.');
          return { kind: track.kind, mid: transceiver.mid };
        }) });
      this.sessionId = allocation.sessionId;
      if (!this.current(epoch))
        return;
      if (allocation.sessionDescription.type !== 'answer')
        throw new Error('Cloudflare SFU returned an invalid publisher answer.');
      await pc.setRemoteDescription(allocation.sessionDescription);
      for (const { track, transceiver } of transceivers) {
        if (track.kind !== 'video')
          continue;
        const parameters = transceiver.sender.getParameters();
        parameters.encodings = [{ ...parameters.encodings?.[0], maxBitrate: options.maxBitrate, maxFramerate: options.frameRate }];
        parameters.degradationPreference = options.degradationPreference;
        await transceiver.sender.setParameters(parameters);
      }
      await waitForPc(pc, 'connectionstatechange', () => pc.connectionState === 'connected', this.abort.signal, 20000);
      await waitForVideoSent(pc, this.abort.signal);
      if (this.current(epoch))
        await this.deps.api.ready(allocation.sessionId);
    });
  }
  subscribe(publication: CloudflareSfuPublication): Promise<void> {
    return this.negotiate(async (epoch) => {
      const pc = await this.create(epoch);
      if (!pc)
        return;
      const stream = this.deps.createMediaStream?.() ?? new MediaStream();
      const pending: RTCTrackEvent[] = [];
      const mapping: {
        tracks?: CloudflareSfuSessionResponse['tracks'];
      } = {};
      const accept = (event: RTCTrackEvent) => {
        if (!this.current(epoch))
          return;
        this.remoteTracks.add(event.track);
        const expected = mapping.tracks?.find(t => t.mid === event.transceiver.mid);
        if (!expected || expected.kind !== event.track.kind)
          return;
        if (!stream.getTracks().includes(event.track))
          stream.addTrack(event.track);
        const show = () => { if (this.current(epoch) && !this.shown && event.track.kind === 'video' && !event.track.muted && event.track.readyState === 'live') {
          this.shown = true;
          this.deps.onStream?.(stream);
        } };
        event.track.addEventListener('unmute', show, { once: true });
        show();
      };
      pc.ontrack = event => { if (mapping.tracks)
        accept(event);
      else
        pending.push(event); };
      const allocation = await this.deps.api.subscribe(publication.shareId);
      this.sessionId = allocation.sessionId;
      if (!this.current(epoch))
        return;
      if (allocation.shareId !== publication.shareId || allocation.sessionDescription.type !== 'offer')
        throw new Error('Cloudflare SFU returned a stale subscription.');
      mapping.tracks = allocation.tracks;
      for (const event of pending)
        accept(event);
      await pc.setRemoteDescription(allocation.sessionDescription);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForPc(pc, 'icegatheringstatechange', () => pc.iceGatheringState === 'complete', this.abort.signal, 8000);
      if (!this.current(epoch))
        return;
      await this.deps.api.answer(allocation.sessionId, description(pc, 'answer'));
      await waitForPc(pc, 'connectionstatechange', () => pc.connectionState === 'connected', this.abort.signal, 20000);
    });
  }
  async getStatsReport(): Promise<RTCStatsReport | undefined> { return this.pc?.getStats(); }
  async close(): Promise<void> {
    this.epoch++;
    this.abort.abort();
    this.pc?.close();
    this.pc = undefined;
    for (const track of this.clones)
      track.stop();
    this.clones.length = 0;
    for (const track of this.remoteTracks) track.stop();
    this.remoteTracks.clear();
    await this.tail.catch(() => undefined);
    await this.cleanup();
  }
  private current(epoch: number): boolean { return epoch === this.epoch && !this.abort.signal.aborted; }
  private async create(epoch: number): Promise<RTCPeerConnection | undefined> {
    if (this.pc || this.abort.signal.aborted)
      throw new Error('Cloudflare SFU session is already used.');
    const ice = await this.deps.fetchIceServers();
    if (!this.current(epoch))
      return;
    const pc = this.deps.createPeerConnection?.(ice) ?? new RTCPeerConnection({ iceServers: ice });
    this.pc = pc;
    pc.addEventListener('connectionstatechange', () => { if (this.current(epoch) && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected'))
      this.deps.onError?.(new Error('Cloudflare SFU media connection was lost. Select retry to reconnect.')); });
    return pc;
  }
  private negotiate(operation: (epoch: number) => Promise<void>): Promise<void> {
    const epoch = this.epoch;
    const task = this.tail.then(() => operation(epoch)).catch(async (error) => {
      this.pc?.close();
      this.pc = undefined;
      for (const track of this.clones)
        track.stop();
      this.clones.length = 0;
      for (const track of this.remoteTracks) track.stop();
      this.remoteTracks.clear();
      await this.cleanup();
      if (this.current(epoch))
        throw error;
    }).finally(async () => { if (!this.current(epoch))
      await this.cleanup(); });
    this.tail = task.catch(() => undefined);
    return task;
  }
  private async cleanup(): Promise<void> {
    const id = this.sessionId;
    this.sessionId = undefined;
    if (id)
      await this.deps.api.close(id).catch(() => undefined);
  }
}
function description(pc: RTCPeerConnection, type: 'offer' | 'answer'): RTCSessionDescriptionInit {
  if (!pc.localDescription?.sdp)
    throw new Error('Cloudflare SFU SDP is missing.');
  return { type, sdp: pc.localDescription.sdp };
}
function waitForPc(pc: RTCPeerConnection, event: string, done: () => boolean, signal: AbortSignal, timeout: number): Promise<void> {
  if (signal.aborted)
    return Promise.reject(new Error('Cloudflare SFU session stopped.'));
  if (done())
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); pc.removeEventListener(event, check); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new Error('Cloudflare SFU session stopped.')); };
    const check = () => { if (done()) {
      cleanup();
      resolve();
    }
    else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanup();
      reject(new Error('Cloudflare SFU connection failed.'));
    } };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Cloudflare SFU negotiation timed out.')); }, timeout);
    pc.addEventListener(event, check);
    signal.addEventListener('abort', abort, { once: true });
    check();
  });
}
export function createCloudflareScreenApi(slug: string): CloudflareScreenApi {
  const base = `/meetings/${encodeURIComponent(slug)}/screen-sfu`;
  const request = (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  return {
    publish: body => apiRequest(`${base}/publish`, CloudflareSfuSessionResponseSchema, request('POST', body)),
    ready: sessionId => apiNoContent(`${base}/publish/ready`, request('POST', { sessionId })),
    subscribe: shareId => apiRequest(`${base}/subscribe`, CloudflareSfuSessionResponseSchema, request('POST', { shareId })),
    answer: (id, sessionDescription) => apiNoContent(`${base}/sessions/${encodeURIComponent(id)}/answer`, request('PUT', { sessionDescription })),
    close: id => apiNoContent(`${base}/sessions/${encodeURIComponent(id)}`, request('DELETE'))
  };
}
async function waitForVideoSent(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!signal.aborted && pc.connectionState === 'connected') {
    const report = await pc.getStats();
    let sent = false;
    report.forEach(stat => { if (stat.type === 'outbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video') && ((stat.framesSent ?? 0) > 0 || stat.bytesSent > 0))
      sent = true; });
    if (sent)
      return;
    if (Date.now() >= deadline)
      break;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error('Cloudflare SFU session stopped.')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 250);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted)
        abort();
    });
  }
  throw new Error('Cloudflare SFU publisher did not send video before the media deadline.');
}
