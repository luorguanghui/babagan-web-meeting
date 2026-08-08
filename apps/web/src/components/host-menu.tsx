import type { ParticipantSummary } from '@meeting/contracts';
import { useEffect, useState } from 'react';

interface HostMenuProps {
  participants: ParticipantSummary[];
  authorizeHost: () => Promise<void>;
  onGrantShare: (identity: string) => Promise<void>;
  onRevokeShare: () => Promise<void>;
  onKick: (identity: string) => Promise<void>;
  onEndMeeting: () => Promise<void>;
  confirmEnd?: () => boolean;
  onAuthorizationChange?: (authorized: boolean) => void;
}

export function HostMenu({
  participants,
  authorizeHost,
  onGrantShare,
  onRevokeShare,
  onKick,
  onEndMeeting,
  confirmEnd = () => window.confirm('End this meeting for everyone?'),
  onAuthorizationChange
}: HostMenuProps) {
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState<string>();
  const [sharingIdentity, setSharingIdentity] = useState<string | undefined>(
    () => participants.find((participant) => participant.isSharing)?.identity
  );

  useEffect(() => {
    let active = true;
    setAuthorized(false);
    void authorizeHost().then(
      () => {
        if (!active) return;
        setAuthorized(true);
        onAuthorizationChange?.(true);
      },
      () => {
        if (!active) return;
        setAuthorized(false);
        onAuthorizationChange?.(false);
      }
    );
    return () => { active = false; };
  }, [authorizeHost, onAuthorizationChange]);

  const externalSharingIdentity = participants.find((participant) => participant.isSharing)?.identity;
  useEffect(() => {
    setSharingIdentity(externalSharingIdentity);
  }, [externalSharingIdentity]);

  if (!authorized) return null;

  async function act(action: () => Promise<void>): Promise<boolean> {
    setError(undefined);
    try {
      await action();
      return true;
    } catch {
      setError('The host action could not be completed.');
      return false;
    }
  }

  async function grant(identity: string) {
    if (await act(() => onGrantShare(identity))) setSharingIdentity(identity);
  }

  async function revoke() {
    if (await act(onRevokeShare)) setSharingIdentity(undefined);
  }

  return <section className="host-menu" aria-labelledby="host-controls-heading">
    <h2 id="host-controls-heading">Host controls</h2>
    {error && <p role="alert">{error}</p>}
    <ul aria-label="Host participant controls">
      {participants.map((participant) => <li key={participant.identity}>
        <span>{participant.name}</span>
        {sharingIdentity === participant.identity
          ? <button type="button" onClick={() => void revoke()}>Revoke screen sharing from {participant.name}</button>
          : <button
              type="button"
              disabled={sharingIdentity !== undefined}
              onClick={() => void grant(participant.identity)}
            >Grant screen sharing to {participant.name}</button>}
        <button type="button" className="danger" onClick={() => void act(() => onKick(participant.identity))}>Kick {participant.name}</button>
      </li>)}
    </ul>
    <button type="button" className="danger" onClick={() => {
      if (confirmEnd()) void act(onEndMeeting);
    }}>End meeting</button>
  </section>;
}
