import { JoinMeetingResponseSchema, type JoinMeetingRequest, type JoinMeetingResponse } from '@meeting/contracts';
import { type FormEvent, useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiRequestError, apiRequest } from '../api/client.js';
import { DeviceCheck } from '../components/device-check.js';
import { MeetingRoomPage } from './meeting-room-page.js';

interface JoinLobbyPageProps { slug: string; }
type ClientNotice = { kind: 'block'; message: string } | { kind: 'notice'; message: string } | undefined;

function clientNotice(): ClientNotice {
  const userAgent = navigator.userAgent;
  if (!window.isSecureContext) return { kind: 'block', message: 'Join from a secure HTTPS connection to use this meeting.' };
  if (!globalThis.RTCPeerConnection) return { kind: 'block', message: 'WebRTC is unavailable in this browser. Use a current Chrome or Edge browser.' };
  if (/Android|iPhone|iPad|iPod|Mobi/i.test(userAgent)) return { kind: 'notice', message: 'Mobile is available for view and voice only; screen sharing is not supported.' };
  if (/Macintosh|Mac OS X/i.test(userAgent)) return { kind: 'block', message: 'This release is supported on Windows 10 or 11 with Chrome or Edge. Please join from a supported computer.' };
  const blockedChromium = /OPR\/|Opera|Brave|Vivaldi|YaBrowser|SamsungBrowser|UCBrowser|DuckDuckGo|Whale/i.test(userAgent)
    || Boolean((navigator as Navigator & { brave?: unknown }).brave);
  const isEdge = /Edg\/\d+/i.test(userAgent);
  const isChrome = /Chrome\/\d+/i.test(userAgent) && !blockedChromium;
  if (!/Windows NT 10\.0/i.test(userAgent) || blockedChromium || (!isChrome && !isEdge)) return { kind: 'block', message: 'This release is supported on Windows 10 or 11 with Chrome or Edge. Please join from a supported computer.' };
  return undefined;
}

export function JoinLobbyPage({ slug }: JoinLobbyPageProps) {
  const navigate = useNavigate();
  const [nickname, setNickname] = useState('');
  const [meetingPassword, setMeetingPassword] = useState('');
  const [error, setError] = useState<string>();
  const [joined, setJoined] = useState<JoinMeetingResponse>();
  const [isJoining, setIsJoining] = useState(false);
  const [previewCleanup, setPreviewCleanup] = useState<(() => void) | null>(null);
  const notice = clientNotice();
  const registerCleanup = useCallback((cleanup: (() => void) | null) => setPreviewCleanup(() => cleanup), []);

  if (joined) return <MeetingRoomPage
    slug={slug}
    join={joined}
    onLeft={() => setJoined(undefined)}
    onTerminal={() => {
      setJoined(undefined);
      navigate(`/m/${encodeURIComponent(slug)}`, { replace: true });
    }}
  />;

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(undefined);
    if (!nickname.trim()) return setError('Nickname is required.');
    if (notice?.kind === 'block') return;
    previewCleanup?.();
    const body: JoinMeetingRequest = { nickname: nickname.trim(), ...(meetingPassword ? { meetingPassword } : {}) };
    setIsJoining(true);
    try {
      const response = await apiRequest<JoinMeetingResponse>(`/meetings/${slug}/join`, JoinMeetingResponseSchema, { method: 'POST', body: JSON.stringify(body) });
      setJoined(response); setMeetingPassword('');
    } catch (reason) { setError(reason instanceof ApiRequestError ? reason.message : 'The meeting could not be joined.'); }
    finally { setIsJoining(false); }
  }
  return <main className="shell"><section className="panel lobby" aria-labelledby="lobby-heading">
    <p className="eyebrow">Meeting lobby</p><h1 id="lobby-heading">Ready when you are</h1><p className="lede">Choose a name, check your audio if you like, then enter with your microphone muted.</p>
    {notice && <p className={`message ${notice.kind === 'block' ? 'error' : 'notice'}`} role={notice.kind === 'block' ? 'alert' : 'status'}>{notice.message}</p>}
    <form onSubmit={join} noValidate>
      <label>Nickname<input aria-label="Nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={40} autoComplete="name" /></label>
      <label>Meeting password <span className="optional">if required</span><input aria-label="Meeting password" type="password" value={meetingPassword} onChange={(event) => setMeetingPassword(event.target.value)} maxLength={128} autoComplete="current-password" /></label>
      {error && <p className="message error" role="alert">{error}</p>}
      <button type="submit" disabled={isJoining || notice?.kind === 'block'}>{isJoining ? 'Joining…' : 'Join muted'}</button>
    </form>
    <DeviceCheck onCleanupReady={registerCleanup} />
  </section></main>;
}
