import { Activity, ChevronRight, Headphones, LogOut, MonitorUp, Users } from 'lucide-react';

export type MeetingMenuAction = 'participants' | 'audio-devices' | 'screen-settings' | 'webrtc-stats' | 'leave';

const menuIcons = {
  participants: Users,
  'audio-devices': Headphones,
  'screen-settings': MonitorUp,
  'webrtc-stats': Activity,
  leave: LogOut
} as const;

export function MeetingMenu({
  items,
  onAction
}: {
  items: Array<{ action: MeetingMenuAction; label: string }>;
  onAction: (action: MeetingMenuAction) => void;
}) {
  return <nav className="meeting-menu" aria-label="More meeting controls">
    {items.map(({ action, label }) => {
      const Icon = menuIcons[action];
      return <button
        key={action}
        type="button"
        className={action === 'leave' ? 'meeting-menu-row meeting-menu-danger' : 'meeting-menu-row'}
        onClick={() => onAction(action)}
      >
        <Icon aria-hidden="true" size={21} /><span>{label}</span><ChevronRight className="meeting-menu-chevron" aria-hidden="true" size={18} />
      </button>;
    })}
  </nav>;
}
