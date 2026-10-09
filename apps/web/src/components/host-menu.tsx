import type { ParticipantSummary } from '@meeting/contracts';
import { useEffect, useState } from 'react';
import { ApiRequestError } from '../api/client.js';
import { useI18n } from '../i18n/i18n.js';

interface HostMenuProps {
  participants: ParticipantSummary[];
  authorizeHost: () => Promise<void>;
  authorized?: boolean;
  onGrantShare: (identity: string) => Promise<void>;
  onRevokeShare: () => Promise<void>;
  onKick: (identity: string) => Promise<void>;
  onEndMeeting: () => Promise<void>;
  onEnded?: () => void;
  confirmEnd?: () => boolean;
  onAuthorizationChange?: (authorized: boolean) => void;
}

export function HostMenu({
  participants,
  authorizeHost,
  authorized: controlledAuthorized,
  onGrantShare,
  onRevokeShare,
  onKick,
  onEndMeeting,
  onEnded,
  confirmEnd,
  onAuthorizationChange
}: HostMenuProps) {
  const { t } = useI18n();
  const [locallyAuthorized, setLocallyAuthorized] = useState(false);
  const [error, setError] = useState<string>();
  const [ending, setEnding] = useState(false);
  const [sharingIdentity, setSharingIdentity] = useState<string | undefined>(
    () => participants.find((participant) => participant.isSharing)?.identity
  );

  useEffect(() => {
    if (controlledAuthorized !== undefined) return;
    let active = true;
    setLocallyAuthorized(false);
    void authorizeHost().then(
      () => { if (active) { setLocallyAuthorized(true); onAuthorizationChange?.(true); } },
      () => { if (active) { setLocallyAuthorized(false); onAuthorizationChange?.(false); } }
    );
    return () => { active = false; };
  }, [authorizeHost, controlledAuthorized, onAuthorizationChange]);

  const externalSharingIdentity = participants.find((participant) => participant.isSharing)?.identity;
  useEffect(() => { setSharingIdentity(externalSharingIdentity); }, [externalSharingIdentity]);
  if (!(controlledAuthorized ?? locallyAuthorized)) return null;

  async function act(action: () => Promise<void>): Promise<boolean> {
    setError(undefined);
    try { await action(); return true; }
    catch { setError(t('host.failed')); return false; }
  }
  async function grant(identity: string) { if (await act(() => onGrantShare(identity))) setSharingIdentity(identity); }
  async function revoke() { if (await act(onRevokeShare)) setSharingIdentity(undefined); }
  async function endMeeting(): Promise<void> {
    setError(undefined);
    setEnding(true);
    let ended = false;
    try {
      await onEndMeeting();
      ended = true;
    } catch (reason) {
      // The meeting already ended (an earlier click or another host finished
      // it): that is success for this button, not an error.
      ended = reason instanceof ApiRequestError
        && reason.details?.error.code === 'MEETING_EXPIRED';
      if (!ended) setError(t('host.failed'));
    } finally {
      setEnding(false);
    }
    if (ended) onEnded?.();
  }

  return <section className="host-menu" aria-labelledby="host-controls-heading">
    <h2 id="host-controls-heading">{t('host.heading')}</h2>
    {error && <p role="alert">{error}</p>}
    <ul aria-label={t('host.listLabel')}>
      {participants.map((participant) => <li key={participant.identity}>
        <span>{participant.name}</span>
        {sharingIdentity === participant.identity
          ? <button type="button" onClick={() => void revoke()}>{t('host.revoke', { name: participant.name })}</button>
          : <button type="button" disabled={sharingIdentity !== undefined} onClick={() => void grant(participant.identity)}>{t('host.grant', { name: participant.name })}</button>}
        <button type="button" className="danger" onClick={() => void act(() => onKick(participant.identity))}>{t('host.kick', { name: participant.name })}</button>
      </li>)}
    </ul>
    <button type="button" className="danger" disabled={ending} onClick={() => {
      const confirmed = confirmEnd ? confirmEnd() : window.confirm(t('host.confirmEnd'));
      if (confirmed) void endMeeting();
    }}>{ending ? t('host.ending') : t('host.end')}</button>
  </section>;
}
