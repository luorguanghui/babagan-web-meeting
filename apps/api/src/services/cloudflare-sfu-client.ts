import { domainError } from '../domain/errors.js';
import { validateCloudflareSfuGateway } from './cloudflare-sfu-gateway.js';

export interface SfuTrack { location?: 'local' | 'remote'; kind?: 'video' | 'audio'; mid?: string; sessionId?: string; trackName?: string; errorCode?: string }
export interface SfuResult { errorCode?: string; sessionId?: string; sessionDescription?: { type: 'offer' | 'answer'; sdp: string }; tracks?: SfuTrack[]; requiresImmediateRenegotiation?: boolean }
export interface CloudflareSfuApi {
  createSession(): Promise<string>;
  newTracks(sessionId: string, body: { tracks: SfuTrack[]; sessionDescription?: { type: 'offer'; sdp: string } }): Promise<SfuResult>;
  answer(sessionId: string, description: { type: 'answer'; sdp: string }): Promise<void>;
  closeTracks(sessionId: string, mids: string[]): Promise<string[]>;
  getSessionMids(sessionId: string): Promise<string[]>;
  close?(): Promise<void>;
}

/** Fixed-origin SFU control API, optionally via the trusted Worker. Never retry allocations or log upstream bodies/SDP. */
export class CloudflareSfuClient implements CloudflareSfuApi {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly authorization?: string;
  constructor(options: { appId?: string; appSecret?: string; gatewayUrl?: string; timeoutMs?: number }) {
    const gatewayUrl = validateCloudflareSfuGateway(options.gatewayUrl);
    if (gatewayUrl) {
      // The existing Worker selects its application and supplies its own token.
      this.base = gatewayUrl;
    } else {
      if (!options.appId || !options.appSecret) throw new Error('Direct SFU credentials must both be configured');
      if (!/^[A-Za-z0-9_-]+$/.test(options.appId)) throw new Error('Invalid SFU application identifier');
      this.base = `https://rtc.live.cloudflare.com/v1/apps/${options.appId}`;
      this.authorization = `Bearer ${options.appSecret}`;
    }
    this.timeoutMs = options.timeoutMs ?? (gatewayUrl ? 15_000 : 10_000);
  }
  async createSession(): Promise<string> {
    const result = await this.request('/sessions/new', 'POST');
    if (!result.sessionId || !/^[A-Za-z0-9_-]{1,256}$/.test(result.sessionId)) throw domainError('MEDIA_SERVICE_UNAVAILABLE');
    return result.sessionId;
  }
  newTracks(sessionId: string, body: { tracks: SfuTrack[]; sessionDescription?: { type: 'offer'; sdp: string } }): Promise<SfuResult> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/tracks/new`, 'POST', body, true);
  }
  async answer(sessionId: string, description: { type: 'answer'; sdp: string }): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/renegotiate`, 'PUT', { sessionDescription: description });
  }
  async closeTracks(sessionId: string, mids: string[]): Promise<string[]> {
    const result = await this.request(`/sessions/${encodeURIComponent(sessionId)}/tracks/close`, 'PUT', { force: true, tracks: mids.map((mid) => ({ mid })) }, true);
    // A 200 can carry failures. Missing/unreported mids must remain queued.
    return mids.filter((mid) => !result.tracks?.some((t) => t.mid === mid && (!t.errorCode || t.errorCode === 'close_track_error')));
  }
  async getSessionMids(sessionId: string): Promise<string[]> {
    const result = await this.request(`/sessions/${encodeURIComponent(sessionId)}`, 'GET');
    if (!Array.isArray(result.tracks)) throw domainError('MEDIA_SERVICE_UNAVAILABLE');
    return result.tracks.flatMap((track) => typeof track.mid === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(track.mid) ? [track.mid] : []);
  }
  async close(): Promise<void> {}
  private async request(path: string, method: string, body?: unknown, allowTrackErrors = false): Promise<SfuResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      const response = await fetch(this.base + path, {
        method, redirect: 'error', signal: controller.signal,
        headers: { ...(this.authorization ? { Authorization: this.authorization } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw domainError('MEDIA_SERVICE_UNAVAILABLE');
      const result = await response.json() as SfuResult;
      if (!result || typeof result !== 'object' || (result.errorCode && !allowTrackErrors)) throw domainError('MEDIA_SERVICE_UNAVAILABLE');
      return result;
    } catch { throw domainError('MEDIA_SERVICE_UNAVAILABLE'); }
    finally { clearTimeout(timer); }
  }
}
