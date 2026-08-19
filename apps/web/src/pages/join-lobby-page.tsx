import {
  JoinMeetingResponseSchema,
  MeetingSummarySchema,
  type JoinMeetingRequest,
  type JoinMeetingResponse,
  type MeetingSummary
} from '@meeting/contracts';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiRequestError, apiRequest } from '../api/client.js';
import { DeviceCheck } from '../components/device-check.js';
import { apiErrorText, type Translate, useI18n } from '../i18n/i18n.js';
import { MeetingRoomPage } from './meeting-room-page.js';

interface JoinLobbyPageProps { slug: string; }
type ClientNotice = { kind: 'block'; message: string } | { kind: 'notice'; message: string } | undefined;

function clientNotice(t: Translate): ClientNotice {
  const userAgent = navigator.userAgent;
  if (!window.isSecureContext) return { kind: 'block', message: t('join.secureRequired') };
  if (!globalThis.RTCPeerConnection) return { kind: 'block', message: t('join.webrtcUnavailable') };
  if (/Android|iPhone|iPad|iPod|Mobi/i.test(userAgent)) return { kind: 'notice', message: t('join.mobileNotice') };
  if (/Macintosh|Mac OS X/i.test(userAgent)) return { kind: 'block', message: t('join.unsupported') };
  const blockedChromium = /OPR\/|Opera|Brave|Vivaldi|YaBrowser|SamsungBrowser|UCBrowser|DuckDuckGo|Whale/i.test(userAgent)
    || Boolean((navigator as Navigator & { brave?: unknown }).brave);
  const isEdge = /Edg\/\d+/i.test(userAgent);
  const isChrome = /Chrome\/\d+/i.test(userAgent) && !blockedChromium;
  if (!/Windows NT 10\.0/i.test(userAgent) || blockedChromium || (!isChrome && !isEdge)) return { kind: 'block', message: t('join.unsupported') };
  return undefined;
}

export function JoinLobbyPage({ slug }: JoinLobbyPageProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [nickname, setNickname] = useState('');
  const [meetingPassword, setMeetingPassword] = useState('');
  const [error, setError] = useState<string>();
  const [joined, setJoined] = useState<JoinMeetingResponse>();
  const [isJoining, setIsJoining] = useState(false);
  const [previewCleanup, setPreviewCleanup] = useState<(() => void) | null>(null);
  const [summary, setSummary] = useState<MeetingSummary>();
  const notice = clientNotice(t);
  const registerCleanup = useCallback((cleanup: (() => void) | null) => setPreviewCleanup(() => cleanup), []);
  const passwordRequired = summary?.requiresPassword === true;

  useEffect(() => {
    let active = true;
    void apiRequest<MeetingSummary>(
      `/meetings/${encodeURIComponent(slug)}`,
      MeetingSummarySchema
    ).then(
      (value) => { if (active) setSummary(value); },
      () => { if (active) setSummary(undefined); }
    );
    return () => { active = false; };
  }, [slug, t]);

  if (joined) return <MeetingRoomPage
    slug={slug}
    join={joined}
    onLeft={() => setJoined(undefined)}
    onTerminal={(reason) => {
      setJoined(undefined);
      navigate(reason === 'rejoin-required' ? `/m/${encodeURIComponent(slug)}` : '/create', { replace: true });
    }}
  />;

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(undefined);
    if (!nickname.trim()) return setError(t('join.nicknameRequired'));
    if (passwordRequired && !meetingPassword) return setError(t('join.passwordRequired'));
    if (notice?.kind === 'block') return;
    previewCleanup?.();
    const body: JoinMeetingRequest = { nickname: nickname.trim(), ...(meetingPassword ? { meetingPassword } : {}) };
    setIsJoining(true);
    try {
      const response = await apiRequest<JoinMeetingResponse>(`/meetings/${slug}/join`, JoinMeetingResponseSchema, { method: 'POST', body: JSON.stringify(body) });
      setJoined(response); setMeetingPassword('');
    } catch (reason) { setError(reason instanceof ApiRequestError ? apiErrorText(reason, t, 'join.failed') : t('join.failed')); }
    finally { setIsJoining(false); }
  }
  return <main className="shell"><section className="panel lobby" aria-labelledby="lobby-heading">
    <p className="eyebrow">{t('join.eyebrow')}</p><h1 id="lobby-heading">{t('join.heading')}</h1><p className="lede">{t('join.lede')}</p>
    {notice && <p className={`message ${notice.kind === 'block' ? 'error' : 'notice'}`} role={notice.kind === 'block' ? 'alert' : 'status'}>{notice.message}</p>}
    <form onSubmit={join} noValidate>
      <label>{t('join.nickname')}<input aria-label={t('join.nickname')} value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={40} autoComplete="name" /></label>
      <label>{t('join.password')} <span className="optional">{passwordRequired ? t('join.required') : t('common.optional')}</span><input aria-label={t('join.password')} aria-required={passwordRequired} required={passwordRequired} type="password" value={meetingPassword} onChange={(event) => setMeetingPassword(event.target.value)} maxLength={128} autoComplete="current-password" /></label>
      {error && <p className="message error" role="alert">{error}</p>}
      <button type="submit" disabled={isJoining || notice?.kind === 'block'}>{isJoining ? t('join.submitting') : t('join.submit')}</button>
    </form>
    <DeviceCheck onCleanupReady={registerCleanup} />
  </section></main>;
}
