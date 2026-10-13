import { ChartNoAxesColumnIncreasing, Settings, Users } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';

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
  onStats,
  statsButtonRef,
  activePanel,
  participants = [],
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
  onStats?: () => void;
  statsButtonRef?: RefObject<HTMLButtonElement | null>;
  activePanel?: string | null;
  participants?: ReadonlyArray<{ identity: string; name: string }>;
  showTransport?: boolean;
}) {
  return <header className="meeting-topbar meeting-room-header">
    <div className="meeting-room-title">
      <h1>{title}</h1>
      <div className="meeting-connection">{connection}</div>
    </div>
    {showTransport && <div className="meeting-topbar-status" aria-hidden="true">
      <ChartNoAxesColumnIncreasing size={19} /><span>{transportLabel}</span>
    </div>}
    <div className="meeting-presence" aria-hidden="true">
      {participants.slice(0, 5).map((participant, index) => <span className="participant-avatar" data-tone={index % 4} key={participant.identity} title={participant.name}>{Array.from(participant.name.trim())[0]?.toUpperCase()}</span>)}
    </div>
    <nav className="meeting-topbar-actions meeting-navigation-rail" aria-label={navigationLabel}>
      <span className="meeting-brand-mark"><img src="/brand/babagan-icon.svg" alt="Babagan" width="44" height="37" /></span>
      <button ref={participantButtonRef} type="button" className="meeting-topbar-action" aria-label={participantLabel} aria-pressed={activePanel === 'participants'} onClick={onParticipants}>
        <Users aria-hidden="true" size={24} />
        <span>{participantLabel}</span>
        <span className="meeting-participant-count" aria-hidden="true">{participantCount}</span>
      </button>
      <button ref={settingsButtonRef} type="button" className="meeting-topbar-action" aria-pressed={activePanel === 'settings'} onClick={onSettings}>
        <Settings aria-hidden="true" size={24} />
        <span>{settingsLabel}</span>
      </button>
      {onStats && <button ref={statsButtonRef} type="button" className="meeting-topbar-action meeting-nav-stats" aria-pressed={activePanel === 'stats'} onClick={onStats}>
        <ChartNoAxesColumnIncreasing aria-hidden="true" size={24} /><span>{statsLabel}</span>
      </button>}
    </nav>
  </header>;
}
