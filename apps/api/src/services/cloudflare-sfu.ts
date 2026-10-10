import { randomUUID } from 'node:crypto';
import type { CloudflareSfuPublication, CloudflareSfuPublishRequest, CloudflareSfuSessionResponse } from '@meeting/contracts';
import { DomainError, SfuCleanupPendingError, domainError } from '../domain/errors.js';
import type { P2pRoomRegistry } from '../p2p/room-registry.js';
import type { CloudflareSfuApi, SfuResult, SfuTrack } from './cloudflare-sfu-client.js';
import { KeyedMutex } from './keyed-mutex.js';
import type { ActiveParticipantSession, ParticipantApplicationService } from './participant-application-service.js';

type Session = {
  slug: string; owner: ActiveParticipantSession; id: string; shareId: string;
  role: 'publisher' | 'viewer'; state: 'pending' | 'ready' | 'closing';
  uncertainUntil?: number;
  expiresAt: number; mids: string[]; tracks: CloudflareSfuSessionResponse['tracks'];
};

/** Meeting-scoped mutation queues also serialize close behind in-flight allocations. */
export class CloudflareSfuService {
  private readonly closedSessions = new Map<string, { slug: string; identity: string; tokenHash: string; expiresAt: number }>();
  private readonly sessions = new Map<string, Session>();
  private readonly mutex = new KeyedMutex();
  private readonly timer: NodeJS.Timeout;
  private sweepPromise?: Promise<void>;
  private shuttingDown = false;
  constructor(private readonly dependencies: {
    api?: CloudflareSfuApi; participants: ParticipantApplicationService; registry: P2pRoomRegistry;
    now?: () => number; sweepMs?: number;
  }) {
    this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, dependencies.sweepMs ?? 5_000);
    this.timer.unref();
  }
  async status(slug: string) {
    await this.reconcile(slug);
    return { available: !!this.dependencies.api, publication: this.dependencies.registry.getScreenSfu(slug) };
  }
  publish(slug: string, owner: ActiveParticipantSession, input: CloudflareSfuPublishRequest): Promise<CloudflareSfuSessionResponse> {
    return this.mutex.runExclusive(slug, async () => {
      await this.prune(slug);
      this.assertPublisher(slug, owner);
      if (input.tracks.filter((t) => t.kind === 'video').length !== 1 || input.tracks.filter((t) => t.kind === 'audio').length > 1 || new Set(input.tracks.map((t) => t.mid)).size !== input.tracks.length) throw domainError('UNSUPPORTED_CLIENT');
      const tracks = input.tracks.map((t) => ({ ...t, trackName: `screen_${randomUUID().replaceAll('-', '')}_${t.kind}` }));
      return this.allocate(slug, owner, 'publisher', randomUUID(), tracks.map((t) => ({ ...t, location: 'local' })), input.sessionDescription);
    });
  }
  ready(slug: string, owner: ActiveParticipantSession, id: string): Promise<void> {
    return this.mutex.runExclusive(slug, async () => {
      await this.prune(slug);
      const session = this.owned(slug, owner, id);
      if (session.role !== 'publisher' || session.state === 'closing') throw domainError('SHARE_NOT_AUTHORIZED');
      this.assertPublisher(slug, owner);
      session.state = 'ready';
      const publication: CloudflareSfuPublication = { shareId: session.shareId, sessionId: session.id, sharerIdentity: owner.identity, sharerName: owner.nickname, tracks: session.tracks.map(({ kind, trackName }) => ({ kind, trackName })) };
      this.dependencies.registry.setScreenSfu(slug, publication);
    });
  }
  subscribe(slug: string, owner: ActiveParticipantSession, shareId: string): Promise<CloudflareSfuSessionResponse> {
    return this.mutex.runExclusive(slug, async () => {
      await this.prune(slug);
      this.assertActive(slug, owner);
      const publication = this.dependencies.registry.getScreenSfu(slug);
      if (!publication || publication.shareId !== shareId || publication.sharerIdentity === owner.identity) throw domainError('SHARE_NOT_AUTHORIZED');
      return this.allocate(slug, owner, 'viewer', shareId, publication.tracks.map((t) => ({ ...t, location: 'remote', sessionId: publication.sessionId })));
    });
  }
  answer(slug: string, owner: ActiveParticipantSession, id: string, description: { type: 'answer'; sdp: string }): Promise<void> {
    return this.mutex.runExclusive(slug, async () => {
      await this.prune(slug);
      const session = this.owned(slug, owner, id);
      if (session.role !== 'viewer' || session.state !== 'pending') throw domainError('SHARE_NOT_AUTHORIZED');
      try {
        await this.api().answer(id, description);
        this.assertCurrent(session);
        session.state = 'ready';
      } catch (error) { await this.remove(session); throw error; }
    });
  }
  stop(slug: string, owner: ActiveParticipantSession, id: string): Promise<void> {
    return this.mutex.runExclusive(slug, async () => {
      const session = this.sessions.get(id);
      if (!session) {
        const closed = this.closedSessions.get(id);
        if (!closed || closed.expiresAt <= this.now() || closed.slug !== slug || closed.identity !== owner.identity || closed.tokenHash !== owner.tokenHash) throw domainError('SHARE_NOT_AUTHORIZED');
        return;
      }
      if (session.slug !== slug || session.owner.identity !== owner.identity || session.owner.tokenHash !== owner.tokenHash) throw domainError('SHARE_NOT_AUTHORIZED');
      await this.remove(session);
    });
  }
  reconcile(slug: string): Promise<void> { return this.mutex.runExclusive(slug, () => this.prune(slug)); }
  closeParticipant(slug: string, identity: string): Promise<void> {
    return this.mutex.runExclusive(slug, async () => {
      for (const session of [...this.sessions.values()]) if (session.slug === slug && session.owner.identity === identity) await this.remove(session);
    });
  }
  closeMeeting(slug: string): Promise<void> {
    return this.mutex.runExclusive(slug, async () => {
      this.dependencies.registry.setScreenSfu(slug, null);
      for (const session of [...this.sessions.values()]) if (session.slug === slug) await this.remove(session);
    });
  }
  sweep(): Promise<void> {
    if (this.sweepPromise) return this.sweepPromise;
    this.sweepPromise = Promise.resolve().then(async () => {
      try {
        for (const slug of new Set([...this.sessions.values()].map((s) => s.slug))) await this.reconcile(slug);
      } finally { this.sweepPromise = undefined; }
    });
    return this.sweepPromise;
  }
  async close(): Promise<void> {
    this.shuttingDown = true; clearInterval(this.timer);
    for (const slug of new Set([...this.sessions.values()].map((s) => s.slug))) await this.closeMeeting(slug);
    await this.dependencies.api?.close?.();
  }
  private async allocate(slug: string, owner: ActiveParticipantSession, role: Session['role'], shareId: string, tracks: SfuTrack[], description?: { type: 'offer'; sdp: string }): Promise<CloudflareSfuSessionResponse> {
    const api = this.api();
    // Reconnecting replaces the owner's prior connection, never accumulates senders.
    for (const old of [...this.sessions.values()]) if (old.slug === slug && old.owner.identity === owner.identity && old.role === role) await this.remove(old);
    if ([...this.sessions.values()].some((s) => s.slug === slug && s.owner.identity === owner.identity && s.role === role)) throw new SfuCleanupPendingError();
    if ([...this.sessions.values()].filter((s) => s.slug === slug).length >= 5) throw domainError('MEETING_FULL');
    const id = await api.createSession();
    const session: Session = { slug, owner, id, role, shareId, state: 'pending', expiresAt: this.now() + 30_000, mids: tracks.flatMap((t) => t.mid ? [t.mid] : []), tracks: [] };
    this.sessions.set(id, session);
    try {
      this.assertCurrent(session);
      // A timeout cannot prove the upstream allocation was cancelled. Continue
      // inspecting this session for late mids before allowing owner replacement.
      session.uncertainUntil = this.now() + 60_000;
      const result = await api.newTracks(id, { tracks, ...(description ? { sessionDescription: description } : {}) });
      session.mids = [...new Set([...session.mids, ...(Array.isArray(result.tracks) ? result.tracks : []).flatMap((t) => typeof t.mid === 'string' ? [t.mid] : [])])];
      if (Array.isArray(result.tracks) && tracks.every((track) => result.tracks!.some((returned) => returned.trackName === track.trackName && typeof returned.mid === 'string'))) session.uncertainUntil = undefined;
      this.validateTracks(result, tracks, role);
      session.uncertainUntil = undefined;
      session.tracks = tracks.map((track) => {
        const matched = result.tracks!.find((t) => t.trackName === track.trackName)!;
        return { kind: track.kind!, trackName: track.trackName!, mid: matched.mid! };
      });
      this.assertCurrent(session);
      // Allocation has its own API timeout. Start the browser's bounded
      // negotiation window when its offer/answer is actually available.
      session.expiresAt = this.now() + 30_000;
      return { sessionId: id, shareId, sessionDescription: result.sessionDescription!, tracks: session.tracks };
    } catch (error) { await this.remove(session); throw error instanceof DomainError ? error : domainError('MEDIA_SERVICE_UNAVAILABLE'); }
  }
  private validateTracks(result: SfuResult, requested: SfuTrack[], role: Session['role']): void {
    const description = result.sessionDescription;
    if (result.errorCode || !description || description.type !== (role === 'publisher' ? 'answer' : 'offer') || typeof description.sdp !== 'string' || !description.sdp || description.sdp.length > 65_536 || result.tracks?.length !== requested.length || (role === 'publisher' && result.requiresImmediateRenegotiation)) throw domainError('MEDIA_SERVICE_UNAVAILABLE');
    const mids = new Set<string>();
    for (const track of requested) {
      const matches = result.tracks.filter((t) => t.trackName === track.trackName);
      const matched = matches[0];
      if (matches.length !== 1 || matched.errorCode || !matched.mid || !/^[A-Za-z0-9_-]{1,32}$/.test(matched.mid) || mids.has(matched.mid) || (role === 'publisher' && matched.mid !== track.mid)) throw domainError('MEDIA_SERVICE_UNAVAILABLE');
      mids.add(matched.mid);
    }
  }
  private async prune(slug: string): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      if (session.slug !== slug) continue;
      let invalid = session.state === 'closing' || (session.state === 'pending' && this.now() >= session.expiresAt);
      try { this.assertCurrent(session); } catch { invalid = true; }
      if (invalid) await this.remove(session);
    }
  }
  private async remove(session: Session): Promise<void> {
    session.state = 'closing';
    if (session.role === 'publisher') {
      if (this.dependencies.registry.getScreenSfu(session.slug)?.shareId === session.shareId) this.dependencies.registry.setScreenSfu(session.slug, null);
      for (const child of [...this.sessions.values()]) if (child.role === 'viewer' && child.slug === session.slug && child.shareId === session.shareId) await this.remove(child);
    }
    try {
      let inspected = true;
      if (session.uncertainUntil !== undefined) {
        try { session.mids = [...new Set([...session.mids, ...await this.api().getSessionMids(session.id)])]; }
        catch { inspected = false; }
      }
      if (session.mids.length) session.mids = await this.api().closeTracks(session.id, session.mids);
      if (session.mids.length === 0 && inspected && (session.uncertainUntil === undefined || this.now() >= session.uncertainUntil)) {
        this.sessions.delete(session.id);
        this.closedSessions.set(session.id, { slug: session.slug, identity: session.owner.identity, tokenHash: session.owner.tokenHash, expiresAt: this.now() + 300_000 });
        for (const [id, closed] of this.closedSessions) if (closed.expiresAt <= this.now()) this.closedSessions.delete(id);
        while (this.closedSessions.size > 500) this.closedSessions.delete(this.closedSessions.keys().next().value!);
      }
    } catch { /* retain known mids for safe forced-close cleanup during sweeps */ }
  }
  private assertCurrent(session: Session): void {
    this.assertActive(session.slug, session.owner);
    if (session.role === 'publisher') this.assertPublisher(session.slug, session.owner);
    else if (this.dependencies.registry.getScreenSfu(session.slug)?.shareId !== session.shareId) throw domainError('SHARE_NOT_AUTHORIZED');
    if (session.state === 'pending' && this.now() >= session.expiresAt) throw domainError('SHARE_NOT_AUTHORIZED');
  }
  private assertPublisher(slug: string, owner: ActiveParticipantSession): void {
    this.assertActive(slug, owner);
    if (this.dependencies.participants.getShareIdentity(slug) !== owner.identity) throw domainError('SHARE_NOT_AUTHORIZED');
  }
  private assertActive(slug: string, owner: ActiveParticipantSession): void {
    if (this.shuttingDown || !this.dependencies.participants.isParticipantActive(owner, slug)) throw domainError('SHARE_NOT_AUTHORIZED');
  }
  private owned(slug: string, owner: ActiveParticipantSession, id: string): Session {
    this.assertActive(slug, owner);
    const session = this.sessions.get(id);
    if (!session || session.slug !== slug || session.owner.identity !== owner.identity || session.owner.tokenHash !== owner.tokenHash) throw domainError('SHARE_NOT_AUTHORIZED');
    return session;
  }
  private api(): CloudflareSfuApi { if (!this.dependencies.api) throw domainError('MEDIA_SERVICE_UNAVAILABLE'); return this.dependencies.api; }
  private now(): number { return this.dependencies.now?.() ?? Date.now(); }
}
