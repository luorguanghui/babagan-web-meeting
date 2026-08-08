import { describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../api/client.js';
import { createReconnectController } from './reconnect-controller.js';
import type { JoinMeetingResponse } from '@meeting/contracts';

const join = {
  participantIdentity: 'participant-1', participantName: 'Ada', livekitUrl: 'wss://rtc.example.test',
  token: 'fresh-token', meetingExpiresAt: 99_999, permissions: { publishSources: ['microphone'] }
} satisfies JoinMeetingResponse;

describe('reconnect controller', () => {
  it('refreshes and reconnects inside the 30-second identity grace window', async () => {
    const refresh = vi.fn(async () => join);
    const reconnect = vi.fn(async () => undefined);
    const controller = createReconnectController({ refresh, reconnect, now: () => 10_000 });

    await controller.reconnect();

    expect(refresh).toHaveBeenCalledOnce();
    expect(reconnect).toHaveBeenCalledWith(join);
    expect(controller.getState()).toEqual({ kind: 'connected' });
  });

  it('keeps exactly one token refresh in flight', async () => {
    let resolve!: (value: typeof join) => void;
    const refresh = vi.fn(() => new Promise<typeof join>((done) => { resolve = done; }));
    const controller = createReconnectController({ refresh, reconnect: vi.fn(async () => undefined) });
    const first = controller.reconnect();
    const second = controller.reconnect();
    expect(refresh).toHaveBeenCalledOnce();
    resolve(join);
    await Promise.all([first, second]);
  });

  it('does nothing after disposal when an in-flight refresh resolves', async () => {
    let resolve!: (value: typeof join) => void;
    const reconnect = vi.fn(async () => undefined);
    const controller = createReconnectController({
      refresh: () => new Promise<typeof join>((done) => { resolve = done; }), reconnect
    });
    const states: string[] = [];
    controller.subscribe((state) => states.push(state.kind));
    const pending = controller.reconnect();
    controller.dispose();
    resolve(join);
    await pending;

    expect(reconnect).not.toHaveBeenCalled();
    expect(states).toEqual(['connected', 'refreshing-token']);
  });

  it('does not mutate reconnect state when disposal races an in-flight reconnect', async () => {
    let resolveReconnect!: () => void;
    const controller = createReconnectController({
      refresh: vi.fn(async () => join),
      reconnect: () => new Promise<void>((done) => { resolveReconnect = done; })
    });
    const states: string[] = [];
    controller.subscribe((state) => states.push(state.kind));
    const pending = controller.reconnect();
    await vi.waitFor(() => expect(resolveReconnect).toBeTypeOf('function'));
    controller.dispose();
    resolveReconnect();
    await pending;

    expect(states).toEqual(['connected', 'refreshing-token']);
  });

  it('does not reconnect when a slow refresh passes the thirty-second deadline', async () => {
    let now = 0;
    let resolve!: (value: typeof join) => void;
    const scheduled: Array<() => void> = [];
    const reconnect = vi.fn(async () => undefined);
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise<typeof join>((done) => { resolve = done; }));
    const controller = createReconnectController({
      refresh, reconnect, now: () => now,
      schedule: (callback) => { scheduled.push(callback); return scheduled.length; }, cancel: vi.fn()
    });
    await controller.reconnect();
    now = 29_000;
    scheduled.shift()?.();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    now = 30_001;
    resolve(join);
    await vi.waitFor(() => expect(controller.getState()).toEqual({ kind: 'rejoin-required', reason: 'grace-expired' }));

    expect(reconnect).not.toHaveBeenCalled();
  });

  it('does not accept a reconnect that completes after the grace deadline', async () => {
    let now = 0;
    let resolveReconnect!: () => void;
    const controller = createReconnectController({
      refresh: vi.fn(async () => join),
      reconnect: () => new Promise<void>((done) => { resolveReconnect = done; }),
      now: () => now
    });
    const pending = controller.reconnect();
    await vi.waitFor(() => expect(resolveReconnect).toBeTypeOf('function'));
    now = 30_001;
    resolveReconnect();
    await pending;

    expect(controller.getState()).toEqual({ kind: 'rejoin-required', reason: 'grace-expired' });
  });

  it('requires a new join after thirty seconds of failed recovery', async () => {
    let now = 10_000;
    const scheduled: Array<() => void> = [];
    const controller = createReconnectController({
      refresh: vi.fn(async () => { throw new Error('offline'); }),
      reconnect: vi.fn(async () => undefined),
      now: () => now,
      schedule: (callback) => { scheduled.push(callback); return scheduled.length; },
      cancel: vi.fn()
    });

    await controller.reconnect();
    now = 40_001;
    scheduled.shift()?.();
    await vi.waitFor(() => expect(controller.getState()).toEqual({ kind: 'rejoin-required', reason: 'grace-expired' }));
  });

  it('stops retrying and requires rejoin when the participant session is revoked', async () => {
    const controller = createReconnectController({
      refresh: vi.fn(async () => { throw new ApiRequestError('No session', 401); }),
      reconnect: vi.fn(async () => undefined)
    });

    await controller.reconnect();

    expect(controller.getState()).toEqual({ kind: 'rejoin-required', reason: 'session-revoked' });
  });

  it('marks a 429 recovery failure so the UI can explain the retry', async () => {
    const controller = createReconnectController({
      refresh: vi.fn(async () => { throw new ApiRequestError('Busy', 429); }),
      reconnect: vi.fn(async () => undefined), schedule: vi.fn()
    });
    await controller.reconnect();
    expect(controller.isRateLimited()).toBe(true);
  });

  it.each(['MEETING_EXPIRED', 'MEETING_NOT_FOUND'] as const)('routes terminal meeting errors without retrying: %s', async (code) => {
    const controller = createReconnectController({
      refresh: vi.fn(async () => { throw new ApiRequestError('Ended', 410, { error: { code, message: 'Ended', correlationId: 'c-1' } }); }),
      reconnect: vi.fn(async () => undefined)
    });

    await controller.reconnect();

    expect(controller.getState()).toEqual({ kind: 'terminal', reason: code === 'MEETING_EXPIRED' ? 'expired' : 'ended' });
  });
});
