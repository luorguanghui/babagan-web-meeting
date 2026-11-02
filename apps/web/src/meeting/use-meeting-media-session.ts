import { useEffect, useRef } from 'react';

/** Describe the actual conference audio to Android's lock-screen media controls. */
export function useMeetingMediaSession(active: boolean, title: string, onLeave: () => void): void {
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  useEffect(() => {
    if (!active || !navigator.mediaSession) return;
    const session = navigator.mediaSession;
    const previous = session.metadata;
    const metadata = typeof MediaMetadata === 'function' ? new MediaMetadata({ title, artist: 'Babagan' }) : null;
    if (metadata) session.metadata = metadata;
    type ConferenceAction = MediaSessionAction | 'hangup';
    const setAction = session.setActionHandler.bind(session) as (action: ConferenceAction, handler: (() => void) | null) => void;
    const actions: ConferenceAction[] = [];
    const add = (action: ConferenceAction, handler: () => void) => {
      try { setAction(action, handler); actions.push(action); } catch { /* Optional browser capability. */ }
    };
    add('play', () => window.dispatchEvent(new Event('babagan-resume-media')));
    add('hangup', () => leaveRef.current());
    return () => {
      for (const action of actions) setAction(action, null);
      if (metadata && session.metadata === metadata) session.metadata = previous;
    };
  }, [active, title]);
}
