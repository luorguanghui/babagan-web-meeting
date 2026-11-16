import { randomUUID } from 'node:crypto';

import type { ScreenMoqConnectionResponse, ScreenMoqPublication, ScreenMoqStatusResponse } from '@meeting/contracts';

import { domainError } from '../domain/errors.js';
import type { MoqRelayJournal, MoqRelayRecord } from '../repositories/sqlite-moq-relay-journal.js';
import { CloudflareMoqRequestError, type CloudflareMoqApi, type MoqConnectionToken } from './cloudflare-moq-client.js';
import { KeyedMutex } from './keyed-mutex.js';
import type { ActiveParticipantSession, ParticipantApplicationService } from './participant-application-service.js';

const SETUP_LEASE_MS = 30_000;
const ACTIVE_LEASE_MS = 90_000;
const TOKEN_TTL_MS = 5 * 60_000;
const MAX_VIEWER_TOKENS = 7; // Cloudflare's 10 slots include the two defaults and our publisher token.
const MAX_TRACKED_RELAYS = 12;
const UNCERTAIN_RELAY_MS = 60_000;

interface Relay extends MoqRelayRecord {
  removed?: boolean;
  cleanup?: Promise<void>;
}

interface Viewer {
  session: ActiveParticipantSession;
  token: MoqConnectionToken;
}

interface Share {
  metadata: ScreenMoqPublication;
  relay: Relay;
  owner: ActiveParticipantSession;
  grant: number;
  expiresAt: number;
  publisher?: MoqConnectionToken;
  viewers: Map<string, Viewer>;
  ready: boolean;
}

export class CloudflareMoqService {
  private readonly shares = new Map<string, Share>();
  private readonly retired = new Set<Relay>();
  private readonly mutex = new KeyedMutex();
  private readonly timer?: NodeJS.Timeout;
  private shuttingDown = false;
  private sweep?: Promise<void>;

  constructor(private readonly dependencies: {
    api?: CloudflareMoqApi;
    journal?: MoqRelayJournal;
    participants: Pick<ParticipantApplicationService, 'getShareGrantGeneration' | 'isParticipantActive'>;
  }) {
    if (dependencies.api) {
      for (const relay of dependencies.journal?.list() ?? []) this.retired.add(relay);
      void this.runSweep();
      this.timer = setInterval(() => { void this.runSweep(); }, 5_000);
      this.timer.unref();
    }
  }

  status(slug: string): ScreenMoqStatusResponse {
    const share = this.current(slug);
    return { available: !!this.dependencies.api, publication: share?.ready ? share.metadata : null };
  }

  publish(slug: string, owner: ActiveParticipantSession): Promise<ScreenMoqConnectionResponse> {
    return this.mutex.runExclusive(slug, async () => {
      this.assertActive(slug, owner);
      const grant = this.dependencies.participants.getShareGrantGeneration(slug, owner.identity);
      if (grant === null) throw domainError('SHARE_NOT_AUTHORIZED');
      const api = this.api();
      const existing = this.current(slug);
      if (existing?.publisher && existing.publisher.expiresAt > Date.now()) return this.connection(existing, existing.publisher);
      if (existing) await this.withdraw(slug, existing);
      if (this.shares.size + this.retired.size >= MAX_TRACKED_RELAYS) throw domainError('MEDIA_SERVICE_UNAVAILABLE');
      const shareId = randomUUID();
      const share: Share = {
        metadata: { shareId, namespace: 'screen.hang', sharerIdentity: owner.identity, sharerName: owner.nickname },
        relay: { name: 'meeting-screen-' + shareId, createdAt: Date.now() },
        owner, grant, expiresAt: Date.now() + SETUP_LEASE_MS, viewers: new Map(), ready: false
      };
      this.assertActive(slug, owner);
      if (this.dependencies.participants.getShareGrantGeneration(slug, owner.identity) !== grant) {
        throw domainError('SHARE_NOT_AUTHORIZED');
      }
      this.dependencies.journal?.save(share.relay);
      this.shares.set(slug, share);
      try {
        share.relay.id = await api.createRelay(share.relay.name);
      } catch (error) {
        if (this.shares.get(slug) === share) this.shares.delete(slug);
        if (error instanceof CloudflareMoqRequestError && error.definitivelyRejected) this.dependencies.journal?.forget(share.relay.name);
        else this.retired.add(share.relay);
        throw domainError('MEDIA_SERVICE_UNAVAILABLE');
      }

      try {
        this.dependencies.journal?.save(share.relay);
        this.assertCurrent(slug, share);
        const token = await api.createToken(share.relay.id, 'publisher', Date.now() + TOKEN_TTL_MS);
        this.assertCurrent(slug, share);
        if (token.expiresAt <= Date.now()) throw new CloudflareMoqRequestError();
        share.publisher = token;
        // The browser's time to connect starts after the management requests finish.
        share.expiresAt = Date.now() + SETUP_LEASE_MS;
        return this.connection(share, token);
      } catch (error) {
        await this.withdraw(slug, share);
        if (error instanceof CloudflareMoqRequestError) throw domainError('MEDIA_SERVICE_UNAVAILABLE');
        throw error;
      }
    });
  }

  heartbeat(slug: string, owner: ActiveParticipantSession, shareId: string): void {
    const share = this.current(slug);
    if (!share || !share.publisher || !this.isOwner(share, owner, shareId)) throw domainError('SHARE_NOT_AUTHORIZED');
    share.ready = true;
    // Hidden browser tabs may batch heartbeat timers on a minute cadence.
    share.expiresAt = Date.now() + ACTIVE_LEASE_MS;
  }

  async stop(slug: string, owner: ActiveParticipantSession, shareId: string): Promise<void> {
    const share = this.shares.get(slug);
    if (!share || !this.isOwner(share, owner, shareId)) throw domainError('SHARE_NOT_AUTHORIZED');
    await this.withdraw(slug, share);
  }

  subscribe(slug: string, owner: ActiveParticipantSession, shareId: string): Promise<ScreenMoqConnectionResponse> {
    return this.mutex.runExclusive(slug, async () => {
      this.assertActive(slug, owner);
      const share = this.current(slug);
      if (!share?.ready || share.metadata.shareId !== shareId || share.owner.identity === owner.identity || !share.relay.id) {
        throw domainError('SHARE_NOT_AUTHORIZED');
      }
      const api = this.api();
      const previous = share.viewers.get(owner.identity);
      if (previous?.session.tokenHash === owner.tokenHash && previous.token.expiresAt > Date.now()) {
        return this.connection(share, previous.token);
      }
      if (!previous && share.viewers.size >= MAX_VIEWER_TOKENS) throw domainError('MEETING_FULL');
      if (previous) {
        try { await api.deleteToken(share.relay.id, previous.token.jti); }
        catch { throw domainError('MEDIA_SERVICE_UNAVAILABLE'); }
      }
      this.assertCurrent(slug, share);
      let token: MoqConnectionToken;
      try {
        token = await api.createToken(share.relay.id, 'viewer', Date.now() + TOKEN_TTL_MS);
      } catch (error) {
        // A lost response could consume a token slot that we cannot revoke by ID.
        if (!(error instanceof CloudflareMoqRequestError) || !error.definitivelyRejected) await this.withdraw(slug, share);
        throw domainError('MEDIA_SERVICE_UNAVAILABLE');
      }
      this.assertCurrent(slug, share);
      if (!this.dependencies.participants.isParticipantActive(owner, slug)) {
        // The connection URL has never been delivered. Revoke it to free a slot.
        try { await api.deleteToken(share.relay.id, token.jti); }
        catch { await this.withdraw(slug, share); }
        throw domainError('SHARE_NOT_AUTHORIZED');
      }
      if (token.expiresAt <= Date.now()) {
        try { await api.deleteToken(share.relay.id, token.jti); }
        catch { await this.withdraw(slug, share); }
        throw domainError('MEDIA_SERVICE_UNAVAILABLE');
      }
      share.viewers.set(owner.identity, { session: owner, token });
      return this.connection(share, token);
    });
  }

  async closeParticipant(slug: string, identity: string): Promise<void> {
    const share = this.shares.get(slug);
    if (share && (share.owner.identity === identity || share.viewers.has(identity))) await this.withdraw(slug, share);
  }

  async reconcile(slug: string): Promise<void> {
    const share = this.shares.get(slug);
    if (share && !this.valid(slug, share)) await this.withdraw(slug, share);
  }

  async closeMeeting(slug: string): Promise<void> {
    const share = this.shares.get(slug);
    if (share) await this.withdraw(slug, share);
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.shares.keys()].map((slug) => this.closeMeeting(slug)));
    await this.sweep;
    await Promise.all([...this.retired].map((relay) => this.cleanRelay(relay)));
  }

  private current(slug: string): Share | undefined {
    const share = this.shares.get(slug);
    if (!share || this.valid(slug, share)) return share;
    void this.withdraw(slug, share);
    return undefined;
  }

  private valid(slug: string, share: Share): boolean {
    return !this.shuttingDown
      && share.expiresAt > Date.now()
      && this.dependencies.participants.isParticipantActive(share.owner, slug)
      && this.dependencies.participants.getShareGrantGeneration(slug, share.owner.identity) === share.grant
      // Cloudflare token revocation does not disconnect existing viewers.
      // Withdraw the relay and reject the publisher's next lease renewal.
      && [...share.viewers.values()].every(({ session }) => this.dependencies.participants.isParticipantActive(session, slug));
  }

  private assertCurrent(slug: string, share: Share): void {
    if (this.current(slug) !== share) throw domainError('SHARE_NOT_AUTHORIZED');
  }

  private assertActive(slug: string, owner: ActiveParticipantSession): void {
    if (this.shuttingDown || !this.dependencies.participants.isParticipantActive(owner, slug)) throw domainError('SHARE_NOT_AUTHORIZED');
  }

  private isOwner(share: Share, owner: ActiveParticipantSession, shareId: string): boolean {
    return share.metadata.shareId === shareId && share.owner.identity === owner.identity && share.owner.tokenHash === owner.tokenHash;
  }

  private connection(share: Share, token: MoqConnectionToken): ScreenMoqConnectionResponse {
    return { shareId: share.metadata.shareId, namespace: share.metadata.namespace, url: token.url };
  }

  private async withdraw(slug: string, share: Share): Promise<void> {
    if (this.shares.get(slug) === share) this.shares.delete(slug);
    share.ready = false;
    share.publisher = undefined;
    share.viewers.clear();
    // A pending create is handled by the creator when its result arrives.
    if (!share.relay.id || share.relay.removed) return;
    this.retired.add(share.relay);
    await this.cleanRelay(share.relay);
  }

  private cleanRelay(relay: Relay): Promise<void> {
    relay.cleanup ??= this.tryCleanRelay(relay).finally(() => { relay.cleanup = undefined; });
    return relay.cleanup;
  }

  private async tryCleanRelay(relay: Relay): Promise<void> {
    try {
      const api = this.api();
      // A timed-out request may have created a relay without returning its ID.
      relay.id ??= await api.findRelay(relay.name, relay.createdAt - 10_000);
      if (relay.id) await api.deleteRelay(relay.id);
      if (relay.id || Date.now() - relay.createdAt >= UNCERTAIN_RELAY_MS) {
        this.dependencies.journal?.forget(relay.name);
        relay.removed = true;
        this.retired.delete(relay);
      }
    } catch {
      // Retain the relay for another sweep when the provider becomes available.
    }
  }

  private runSweep(): Promise<void> {
    this.sweep ??= Promise.all([
      ...[...this.shares.keys()].map((slug) => this.reconcile(slug)),
      ...[...this.retired].map((relay) => this.cleanRelay(relay))
    ]).then(() => {}, () => {}).finally(() => { this.sweep = undefined; });
    return this.sweep;
  }

  private api(): CloudflareMoqApi {
    if (!this.dependencies.api) throw domainError('MEDIA_SERVICE_UNAVAILABLE');
    return this.dependencies.api;
  }
}
