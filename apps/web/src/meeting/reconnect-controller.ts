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

  constructor(private readonly dependencies: Required<Pick<Dependencies, 'refresh' | 'reconnect'>> & Omit<Dependencies, 'refresh' | 'reconnect'>) {}

  reconnect(): Promise<void> {
    if (this.isFinished()) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    const since = this.since ?? this.dependencies.now?.() ?? Date.now();
    this.since = since;
    this.refreshInFlight = this.attempt(since).finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }

  getState(): ReconnectState { return this.state; }
  isRateLimited(): boolean { return this.rateLimited; }

  subscribe(listener: (state: ReconnectState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.timer) {
      if (this.dependencies.cancel) this.dependencies.cancel(this.timer);
      else clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    }
    this.timer = undefined;
    this.listeners.clear();
  }

  private async attempt(since: number): Promise<void> {
    this.setState({ kind: 'refreshing-token', since });
    try {
      const join = await this.dependencies.refresh();
      await this.dependencies.reconnect(join);
      this.since = undefined;
      this.retries = 0;
      this.rateLimited = false;
      this.setState({ kind: 'connected' });
    } catch (error) {
      const terminal = terminalState(error);
      if (terminal) {
        this.setState(terminal);
        return;
      }
      const now = this.dependencies.now?.() ?? Date.now();
      if (now - since >= graceMs) {
        this.setState({ kind: 'rejoin-required', reason: 'grace-expired' });
        return;
      }
      this.rateLimited = error instanceof ApiRequestError && error.status === 429;
      this.setState({ kind: 'reconnecting', since });
      const delay = Math.min(1_000 * (2 ** this.retries++), 5_000);
      this.timer = (this.dependencies.schedule ?? setTimeout)(() => {
        this.timer = undefined;
        void this.reconnect();
      }, delay);
    }
  }

  private isFinished(): boolean {
    return this.state.kind === 'terminal' || this.state.kind === 'rejoin-required';
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
