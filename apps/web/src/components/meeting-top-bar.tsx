import { Settings, Users } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';

export function MeetingTopBar({
  title,
  connection,
  participantCount,
  navigationLabel,
  participantLabel,
  settingsLabel,
  onParticipants,
  onSettings,
  participantButtonRef,
  settingsButtonRef
}: {
  title: string;
  connection: ReactNode;
  participantCount: number;
  navigationLabel: string;
  participantLabel: string;
  settingsLabel: string;
  onParticipants: () => void;
  onSettings: () => void;
  participantButtonRef: RefObject<HTMLButtonElement | null>;
  settingsButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  return <header className="meeting-topbar meeting-room-header">
    <div className="meeting-room-title">
      <span className="meeting-title-mark" aria-hidden="true" />
      <h1>{title}</h1>
    </div>
    <div className="meeting-topbar-status">{connection}</div>
    <nav className="meeting-topbar-actions" aria-label={navigationLabel}>
      <button ref={participantButtonRef} type="button" className="meeting-topbar-action" onClick={onParticipants}>
        <Users aria-hidden="true" size={18} />
        <span>{participantLabel}</span>
        <span aria-hidden="true">{participantCount}</span>
      </button>
      <button ref={settingsButtonRef} type="button" className="meeting-topbar-action" onClick={onSettings}>
        <Settings aria-hidden="true" size={18} />
        <span>{settingsLabel}</span>
      </button>
    </nav>
  </header>;
}
