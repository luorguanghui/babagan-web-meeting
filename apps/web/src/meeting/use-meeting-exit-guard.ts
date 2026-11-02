import { useEffect } from 'react';

/** Browsers supply their own localized confirmation text; visibility is not exit. */
export function useMeetingExitGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const confirmExit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = 'Meeting in progress';
    };
    window.addEventListener('beforeunload', confirmExit);
    return () => window.removeEventListener('beforeunload', confirmExit);
  }, [active]);
}
