import { useEffect, useState } from 'react';

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

/** Retains presentation-only content briefly after its desired state closes. */
export function useExitPresence<T>(value: T | null, durationMs: number): { value: T | null; exiting: boolean } {
  const [retainedValue, setRetainedValue] = useState<T | null>(value);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.(reducedMotionQuery).matches ?? false);

  useEffect(() => {
    const query = window.matchMedia?.(reducedMotionQuery);
    if (!query) return;
    const updatePreference = () => setReducedMotion(query.matches);
    updatePreference();
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', updatePreference);
      return () => query.removeEventListener('change', updatePreference);
    }
    query.addListener?.(updatePreference);
    return () => query.removeListener?.(updatePreference);
  }, []);

  useEffect(() => {
    if (value !== null) {
      setRetainedValue(value);
      return;
    }
    if (retainedValue === null) return;
    if (reducedMotion || durationMs <= 0) {
      setRetainedValue(null);
      return;
    }
    const removal = window.setTimeout(() => setRetainedValue(null), durationMs);
    return () => window.clearTimeout(removal);
  }, [durationMs, reducedMotion, retainedValue, value]);

  const visibleValue = value !== null ? value : reducedMotion || durationMs <= 0 ? null : retainedValue;
  return { value: visibleValue, exiting: value === null && visibleValue !== null };
}
