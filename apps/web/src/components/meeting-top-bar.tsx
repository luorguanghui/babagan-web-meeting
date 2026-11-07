import { ChartNoAxesColumnIncreasing, Settings, Users } from 'lucide-react';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';

export function MeetingTopBar({
  title,
  connection,
  transportLabel,
  participantCount,
  navigationLabel,
  participantLabel,
  settingsLabel,
  onParticipants,
  onSettings,
  participantButtonRef,
  settingsButtonRef,
  statsLabel,
  statsVisibleLabel,
  onStats,
  statsButtonRef,
  activePanel,
  showTransport = false
}: {
  title: string;
  connection: ReactNode;
  transportLabel: string;
  participantCount: number;
  navigationLabel: string;
  participantLabel: string;
  settingsLabel: string;
  onParticipants: () => void;
  onSettings: () => void;
  participantButtonRef: RefObject<HTMLButtonElement | null>;
  settingsButtonRef: RefObject<HTMLButtonElement | null>;
  statsLabel?: string;
  statsVisibleLabel?: string;
  onStats?: () => void;
  statsButtonRef?: RefObject<HTMLButtonElement | null>;
  activePanel?: string | null;
  participants?: ReadonlyArray<{ identity: string; name: string }>;
  showTransport?: boolean;
}) {
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const duration = [Math.floor(elapsed / 3600), Math.floor(elapsed / 60) % 60, elapsed % 60].map(value => String(value).padStart(2, '0')).join(':');
  return <header className="meeting-topbar meeting-room-header">
    <div className="meeting-brand"><span className="meeting-brand-lockup"><img className="meeting-brand-avatar" src="/theme/sigrika-avatar.png" alt="" width="32" height="32" onError={event => { event.currentTarget.hidden = true; }} /><span>Babagan</span></span></div>
    <div className="meeting-room-title">
      <h1>{title}</h1>
      <div className="meeting-room-metadata">
        <div className="meeting-connection">{connection}</div>
        <time className="meeting-duration" aria-label={duration}>{duration}</time>
      </div>
    </div>
    {showTransport && <div className="meeting-topbar-status" aria-hidden="true">
      <ChartNoAxesColumnIncreasing size={16} /><span>{transportLabel}</span>
    </div>}
    <nav className="meeting-topbar-actions" aria-label={navigationLabel}>
      <button ref={participantButtonRef} type="button" className="meeting-topbar-action meeting-members-toggle" aria-label={participantLabel} aria-pressed={activePanel === 'participants'} onClick={onParticipants}>
        <Users aria-hidden="true" size={20} /><span>{participantLabel}</span><span className="meeting-participant-count" aria-hidden="true">{participantCount}</span>
      </button>
      {onStats && <button ref={statsButtonRef} type="button" className="meeting-topbar-action meeting-nav-stats" aria-label={statsVisibleLabel ? `${statsVisibleLabel} · ${statsLabel}` : statsLabel} aria-pressed={activePanel === 'stats'} onClick={onStats}>
        <ChartNoAxesColumnIncreasing aria-hidden="true" size={20} /><span>{statsVisibleLabel ?? statsLabel}</span>
      </button>}
      <button ref={settingsButtonRef} type="button" className="meeting-topbar-action" aria-label={settingsLabel} aria-pressed={activePanel === 'settings'} onClick={onSettings}>
        <Settings aria-hidden="true" size={20} /><span>{settingsLabel}</span>
      </button>
    </nav>
  </header>;
}
