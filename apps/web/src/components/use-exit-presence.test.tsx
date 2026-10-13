import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useExitPresence } from './use-exit-presence.js';

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

function installMotionPreference(initiallyReduced: boolean, legacy = false) {
  let reduced = initiallyReduced;
  const changes = new EventTarget();
  const query = {
    get matches() { return reduced; },
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: changes.addEventListener.bind(changes),
    removeEventListener: changes.removeEventListener.bind(changes),
    dispatchEvent: changes.dispatchEvent.bind(changes),
    addListener: (listener: EventListener) => changes.addEventListener('change', listener),
    removeListener: (listener: EventListener) => changes.removeEventListener('change', listener)
  };
  if (legacy) { Reflect.deleteProperty(query, 'addEventListener'); Reflect.deleteProperty(query, 'removeEventListener'); }
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => query });
  return (next: boolean) => {
    reduced = next;
    changes.dispatchEvent(new Event('change'));
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window, 'matchMedia');
});

describe('exit presence', () => {
  it('retains the latest panel only for the requested exit duration', () => {
    installMotionPreference(false);
    const { result, rerender } = renderHook(({ value }) => useExitPresence(value, 140), { initialProps: { value: 'call' as string | null } });
    expect(result.current).toEqual({ value: 'call', exiting: false });
    rerender({ value: 'shared' });
    expect(result.current).toEqual({ value: 'shared', exiting: false });
    rerender({ value: null });
    expect(result.current).toEqual({ value: 'shared', exiting: true });
    act(() => { vi.advanceTimersByTime(139); });
    expect(result.current).toEqual({ value: 'shared', exiting: true });
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toEqual({ value: null, exiting: false });
  });

  it('cancels stale removal when a panel reopens during its exit', () => {
    installMotionPreference(false);
    const { result, rerender } = renderHook(({ value }) => useExitPresence(value, 160), { initialProps: { value: 'settings' as string | null } });
    rerender({ value: null });
    act(() => { vi.advanceTimersByTime(80); });
    rerender({ value: 'participants' });
    expect(result.current).toEqual({ value: 'participants', exiting: false });
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(160); });
    expect(result.current).toEqual({ value: 'participants', exiting: false });
  });

  it('does not retain closed content when reduced motion is preferred', () => {
    installMotionPreference(true);
    const { result, rerender } = renderHook(({ value }) => useExitPresence(value, 140), { initialProps: { value: 'volume' as string | null } });
    rerender({ value: null });
    expect(result.current).toEqual({ value: null, exiting: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes exiting content immediately if reduced motion is enabled mid-exit', () => {
    const setReduced = installMotionPreference(false);
    const { result, rerender } = renderHook(({ value }) => useExitPresence(value, 140), { initialProps: { value: 'volume' as string | null } });
    rerender({ value: null });
    expect(result.current.exiting).toBe(true);
    act(() => { setReduced(true); });
    expect(result.current).toEqual({ value: null, exiting: false });
    expect(vi.getTimerCount()).toBe(0);
    act(() => { setReduced(false); });
    expect(result.current).toEqual({ value: null, exiting: false });
  });

  it('observes reduced-motion changes through the legacy media-query listener API', () => {
    const setReduced = installMotionPreference(false, true);
    const { result, rerender } = renderHook(({ value }) => useExitPresence(value, 140), { initialProps: { value: 'volume' as string | null } });
    rerender({ value: null });
    expect(result.current.exiting).toBe(true);
    act(() => { setReduced(true); });
    expect(result.current).toEqual({ value: null, exiting: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up the pending removal when its owner unmounts', () => {
    installMotionPreference(false);
    const { rerender, unmount } = renderHook(({ value }) => useExitPresence(value, 140), { initialProps: { value: 'volume' as string | null } });
    rerender({ value: null });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not schedule a removal when initially empty', () => {
    const { result } = renderHook(() => useExitPresence(null, 140));
    expect(result.current).toEqual({ value: null, exiting: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('supports immediate removal with a zero duration', () => {
    const { result, rerender } = renderHook(({ value }) => useExitPresence(value, 0), { initialProps: { value: 'volume' as string | null } });
    rerender({ value: null });
    expect(result.current).toEqual({ value: null, exiting: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
