import { X } from 'lucide-react';
import { useEffect, useId, type ReactNode, type RefObject } from 'react';

export type MeetingPanel = 'participants' | 'settings' | 'stats' | 'more' | null;

export function MeetingDrawer({
  title,
  closeLabel,
  onClose,
  returnFocusRef,
  children
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const headingId = useId();
  const close = () => {
    onClose();
    returnFocusRef?.current?.focus();
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  });
  return <aside className="meeting-drawer" role="dialog" aria-modal="true" aria-labelledby={headingId}>
    <header className="meeting-drawer-header">
      <h2 id={headingId}>{title}</h2>
      <button type="button" className="meeting-drawer-close" aria-label={closeLabel} onClick={close}>
        <X aria-hidden="true" size={20} />
      </button>
    </header>
    <div className="meeting-drawer-body">{children}</div>
  </aside>;
}
