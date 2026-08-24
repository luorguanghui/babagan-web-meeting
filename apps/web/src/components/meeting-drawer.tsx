import { ArrowLeft, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

export type MeetingPanel = 'participants' | 'settings' | 'stats' | 'more' | null;

export function MeetingDrawer({
  title,
  closeLabel,
  backLabel,
  onBack,
  onClose,
  returnFocusRef,
  children
}: {
  title: string;
  closeLabel: string;
  backLabel?: string;
  onBack?: () => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const headingId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const returnFocusRefRef = useRef(returnFocusRef);
  onCloseRef.current = onClose;
  returnFocusRefRef.current = returnFocusRef;
  const close = useCallback(() => {
    const focusTarget = returnFocusRefRef.current?.current;
    onCloseRef.current();
    queueMicrotask(() => focusTarget?.focus());
  }, []);
  useEffect(() => {
    const drawer = drawerRef.current;
    const room = drawer?.closest('.meeting-room');
    const background = room
      ? Array.from(room.children).filter((element) => element !== drawer && !element.classList.contains('meeting-drawer-backdrop'))
      : [];
    background.forEach((element) => element.setAttribute('inert', ''));
    closeButtonRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])'
      )).filter((element) => !element.hidden);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      background.forEach((element) => element.removeAttribute('inert'));
    };
  }, [close]);
  return <><div className="meeting-drawer-backdrop" aria-hidden="true" onClick={close} />
  <aside ref={drawerRef} className="meeting-drawer" role="dialog" aria-modal="true" aria-labelledby={headingId}>
    <header className="meeting-drawer-header">
      {onBack && <button type="button" className="meeting-drawer-back" aria-label={backLabel} onClick={onBack}>
        <ArrowLeft aria-hidden="true" size={20} />
      </button>}
      <h2 id={headingId}>{title}</h2>
      <button ref={closeButtonRef} type="button" className="meeting-drawer-close" aria-label={closeLabel} onClick={close}>
        <X aria-hidden="true" size={20} />
      </button>
    </header>
    <div className="meeting-drawer-body">{children}</div>
  </aside></>;
}
