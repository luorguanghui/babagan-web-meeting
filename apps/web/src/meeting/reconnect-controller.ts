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
  connected(): void;
  getState(): ReconnectState;
  isRateLimited(): boolean;
  subscribe(listener: (state: ReconnectState) => void): () => void;
  dispose(): void;
}

interface Dependencies {
  refresh(signal?: AbortSignal): Promise<JoinToken>;
  reconnect(join: JoinToken, signal?: AbortSignal): Promise<void>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/** Keep the authenticated session during suspension; bound each attempt, not the entire meeting. */
class BrowserReconnectController implements ReconnectController {
  private state: ReconnectState = { kind: 'connected' };
  private readonly listeners = new Set<(state: ReconnectState) => void>();
  private since?: number;
  private retries = 0;
  private inFlight?: Promise<void>;
  private timer?: unknown;
  private attemptTimer?: unknown;
  private abort?: AbortController;
  private rateLimited = false;
  private disposed = false;
  private generation = 0;

  constructor(private readonly dependencies: Dependencies) {}

  reconnect(): Promise<void> {
    if (this.disposed || this.state.kind === 'terminal' || this.state.kind === 'rejoin-required') return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.cancelTimer(this.timer);
    this.timer = undefined;
    const since = this.since ?? this.dependencies.now?.() ?? Date.now();
    this.since = since;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.setState({ kind: 'refreshing-token', since });
    const timeout = new Promise<never>((_, reject) => {
      this.attemptTimer = (this.dependencies.schedule ?? setTimeout)(() => {
        abort.abort();
        reject(new Error('Meeting recovery attempt timed out'));
      }, 30_000);
    });
    const work = (async () => {
      const join = await this.dependencies.refresh(abort.signal);
      if (!this.current(generation) || abort.signal.aborted) return;
      await this.dependencies.reconnect(join, abort.signal);
    })();
    this.inFlight = Promise.race([work, timeout]).then(() => {
      if (!this.current(generation)) return;
      this.since = undefined;
      this.retries = 0;
      this.rateLimited = false;
      this.setState({ kind: 'connected' });
    }, error => {
      if (!this.current(generation)) return;
      abort.abort();
      const terminal = terminalState(error);
      if (terminal) { this.setState(terminal); return; }
      this.rateLimited = error instanceof ApiRequestError && error.status === 429;
      this.setState({ kind: 'reconnecting', since });
      const delay = Math.min(1_000 * 2 ** Math.min(this.retries++, 4), 10_000);
      this.timer = (this.dependencies.schedule ?? setTimeout)(() => {
        this.timer = undefined;
        if (this.current(generation)) void this.reconnect();
      }, delay);
    }).finally(() => {
      if (!this.current(generation)) return;
      this.cancelTimer(this.attemptTimer);
      this.attemptTimer = undefined;
      this.inFlight = undefined;
      this.abort = undefined;
    });
    return this.inFlight;
  }

  getState(): ReconnectState { return this.state; }
  connected(): void {
    if (this.disposed || this.state.kind === 'terminal' || this.state.kind === 'rejoin-required') return;
    if (this.state.kind === 'connected' && !this.inFlight) return;
    this.generation++;
    this.abort?.abort();
    this.cancelTimer(this.timer);
    this.cancelTimer(this.attemptTimer);
    this.timer = undefined;
    this.attemptTimer = undefined;
    this.inFlight = undefined;
    this.abort = undefined;
    this.since = undefined;
    this.retries = 0;
    this.rateLimited = false;
    this.setState({ kind: 'connected' });
  }
  isRateLimited(): boolean { return this.rateLimited; }
  subscribe(listener: (state: ReconnectState) => void): () => void {
    this.listeners.add(listener); listener(this.state);
    return () => this.listeners.delete(listener);
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.abort?.abort();
    this.cancelTimer(this.timer);
    this.cancelTimer(this.attemptTimer);
    this.listeners.clear();
  }
  private current(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private setState(state: ReconnectState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
  private cancelTimer(timer: unknown): void {
    if (timer === undefined) return;
    if (this.dependencies.cancel) this.dependencies.cancel(timer);
    else clearTimeout(timer as ReturnType<typeof setTimeout>);
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
