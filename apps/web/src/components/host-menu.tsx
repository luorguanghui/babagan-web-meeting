import type { ParticipantSummary } from '@meeting/contracts';
import { Mic, MicOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiRequestError } from '../api/client.js';
import { useI18n } from '../i18n/i18n.js';

interface HostMenuProps {
  participants: Array<ParticipantSummary & { isLocal?: boolean; microphoneEnabled?: boolean }>;
  unified?: boolean;
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
  unified = false,
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

  return <section className={`host-menu${unified ? ' host-menu-unified meeting-management' : ''}`} aria-labelledby="host-controls-heading">
    <h2 id="host-controls-heading">{t('host.heading')}</h2>
    {unified && <p className="meeting-member-hint">{t('host.singleShare')}</p>}
    {error && <p role="alert">{error}</p>}
    <ul aria-label={t(unified ? 'participants.label' : 'host.listLabel')}>
      {participants.map((participant, index) => <li key={participant.identity}>
        {unified && <span className="participant-avatar" data-tone={index % 4} aria-hidden="true">{Array.from(participant.name.trim())[0]?.toUpperCase()}</span>}
        <div className="participant-identity"><span className="participant-name">{participant.name}{unified && participant.isLocal && ` (${t('participants.you')})`}</span>
          {unified && <span className="participant-detail">{participant.isLocal ? t('participants.host') : sharingIdentity === participant.identity ? t('participants.sharing') : participant.microphoneEnabled ? t('participants.microphoneOn') : t('participants.muted')}</span>}
        </div>
        {unified && <span className="participant-microphone" role="img" data-muted={!participant.microphoneEnabled} aria-label={t('controls.microphoneStatus', { state: participant.microphoneEnabled ? t('common.on') : t('common.muted') })}>
          {participant.microphoneEnabled ? <Mic aria-hidden="true" size={19} /> : <MicOff aria-hidden="true" size={19} />}
        </span>}
        <div className="participant-host-actions">
        {sharingIdentity === participant.identity
          ? <button type="button" aria-label={t('host.revoke', { name: participant.name })} onClick={() => void revoke()}>{unified ? t('host.revokeShort') : t('host.revoke', { name: participant.name })}</button>
          : <button type="button" aria-label={t('host.grant', { name: participant.name })} disabled={sharingIdentity !== undefined} onClick={() => void grant(participant.identity)}>{unified ? t('host.grantShort') : t('host.grant', { name: participant.name })}</button>}
        <button type="button" className="danger" aria-label={t('host.kick', { name: participant.name })} onClick={() => void act(() => onKick(participant.identity))}>{unified ? t('host.kickShort') : t('host.kick', { name: participant.name })}</button>
        </div>
      </li>)}
    </ul>
    <div className="meeting-end-section">
    <button type="button" className="danger" disabled={ending} onClick={() => {
      const confirmed = confirmEnd ? confirmEnd() : window.confirm(t('host.confirmEnd'));
      if (confirmed) void endMeeting();
    }}>{ending ? t('host.ending') : t('host.end')}</button>
    {unified && <p>{t('host.endHint')}</p>}
    </div>
  </section>;
}
