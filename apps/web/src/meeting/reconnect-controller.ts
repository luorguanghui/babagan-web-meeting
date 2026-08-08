import type { JoinMeetingResponse, RefreshParticipantTokenResponse } from '@meeting/contracts';

import { ApiRequestError } from '../api/client.js';

export type ReconnectState =
  | { kind: 'connected' }
  | { kind: 'reconnecting'; since: number }
  | { kind: 'refreshing-token'; since: number }
  | { kind: 'rejoin-required'; reason: 'grace-expired' | 'session-revoked' }
  | { kind: 'terminal'; reason: 'ended' | 'expired' };

type JoinToken = JoinMeetingResponse | RefreshParticipantTokenResponse;

export interface ReconnectController {
  reconnect(): Promise<void>;
  getState(): ReconnectState;
  isRateLimited(): boolean;
  subscribe(listener: (state: ReconnectState) => void): () => void;
  dispose(): void;
}

interface Dependencies {
  refresh(): Promise<JoinToken>;
  reconnect(join: JoinToken): Promise<void>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
}

const graceMs = 30_000;

class BrowserReconnectController implements ReconnectController {
  private state: ReconnectState = { kind: 'connected' };
  private readonly listeners = new Set<(state: ReconnectState) => void>();
  private since?: number;
  private retries = 0;
  private refreshInFlight?: Promise<void>;
  private timer?: unknown;
  private rateLimited = false;
  private disposed = false;
  private generation = 0;

  constructor(private readonly dependencies: Required<Pick<Dependencies, 'refresh' | 'reconnect'>> & Omit<Dependencies, 'refresh' | 'reconnect'>) {}

  reconnect(): Promise<void> {
    if (this.disposed || this.isFinished()) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    const since = this.since ?? this.dependencies.now?.() ?? Date.now();
    this.since = since;
    const generation = this.generation;
    const inFlight = this.attempt(since, generation);
    this.refreshInFlight = inFlight;
    void inFlight.then(
      () => this.clearInFlight(generation, inFlight),
      () => this.clearInFlight(generation, inFlight)
    );
    return inFlight;
  }

  getState(): ReconnectState { return this.state; }
  isRateLimited(): boolean { return this.rateLimited; }

  subscribe(listener: (state: ReconnectState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.timer) {
      if (this.dependencies.cancel) this.dependencies.cancel(this.timer);
      else clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    }
    this.timer = undefined;
    this.listeners.clear();
  }

  private async attempt(since: number, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    this.setState({ kind: 'refreshing-token', since });
    try {
      const join = await this.dependencies.refresh();
      if (!this.isCurrent(generation)) return;
      if (this.graceExpired(since)) {
        this.setState({ kind: 'rejoin-required', reason: 'grace-expired' });
        return;
      }
      await this.dependencies.reconnect(join);
      if (!this.isCurrent(generation)) return;
      if (this.graceExpired(since)) {
        this.setState({ kind: 'rejoin-required', reason: 'grace-expired' });
        return;
      }
      this.since = undefined;
      this.retries = 0;
      this.rateLimited = false;
      this.setState({ kind: 'connected' });
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      const terminal = terminalState(error);
      if (terminal) {
        this.setState(terminal);
        return;
      }
      if (this.graceExpired(since)) {
        this.setState({ kind: 'rejoin-required', reason: 'grace-expired' });
        return;
      }
      this.rateLimited = error instanceof ApiRequestError && error.status === 429;
      this.setState({ kind: 'reconnecting', since });
      const delay = Math.min(1_000 * (2 ** this.retries++), 5_000);
      this.timer = (this.dependencies.schedule ?? setTimeout)(() => {
        if (!this.isCurrent(generation)) return;
        this.timer = undefined;
        void this.reconnect();
      }, delay);
    }
  }

  private isFinished(): boolean {
    return this.state.kind === 'terminal' || this.state.kind === 'rejoin-required';
  }

  private isCurrent(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private graceExpired(since: number): boolean { return (this.dependencies.now?.() ?? Date.now()) - since >= graceMs; }
  private clearInFlight(generation: number, inFlight: Promise<void>): void {
    if (this.isCurrent(generation) && this.refreshInFlight === inFlight) this.refreshInFlight = undefined;
  }

  private setState(state: ReconnectState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function terminalState(error: unknown): Extract<ReconnectState, { kind: 'terminal' | 'rejoin-required' }> | undefined {
  if (!(error instanceof ApiRequestError)) return undefined;
  if (error.status === 401 || error.status === 403) return { kind: 'rejoin-required', reason: 'session-revoked' };
  const code = error.details?.error.code;
  if (code === 'MEETING_NOT_FOUND') return { kind: 'terminal', reason: 'ended' };
  if (code === 'MEETING_EXPIRED' || error.status === 410) return { kind: 'terminal', reason: 'expired' };
  return undefined;
}

export function createReconnectController(dependencies: Dependencies): ReconnectController {
  return new BrowserReconnectController(dependencies);
}
