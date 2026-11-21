import {
  JoinMeetingResponseSchema,
  MeetingSummarySchema,
  type JoinMeetingRequest,
  type JoinMeetingResponse,
  type MeetingSummary
} from '@meeting/contracts';
import { ArrowRight, ChevronRight, Headphones, LockKeyhole, MonitorUp } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiRequestError, apiRequest } from '../api/client.js';
import { DeviceCheck } from '../components/device-check.js';
import { TaskPageLayout } from '../components/task-page-layout.js';
import { apiErrorText, type Translate, useI18n } from '../i18n/i18n.js';
import { MeetingRoomPage } from './meeting-room-page.js';
import { useClientHost } from '../client/client-host.js';
import './task-meeting-page.css';

interface JoinLobbyPageProps { slug: string; }
type ClientNotice = { kind: 'block'; message: string } | { kind: 'notice'; message: string } | undefined;
type LobbySummaryState =
  | { kind: 'loading' }
  | { kind: 'ready'; slug: string; summary: MeetingSummary }
  | { kind: 'unavailable' };
type JoinedMeeting = { slug: string; meetingName: string; response: JoinMeetingResponse };

function clientNotice(t: Translate, nativeAndroid: boolean): ClientNotice {
  const userAgent = navigator.userAgent;
  if (!window.isSecureContext) return { kind: 'block', message: t('join.secureRequired') };
  if (!globalThis.RTCPeerConnection) return { kind: 'block', message: t('join.webrtcUnavailable') };
  // The installed Android host supplies MediaProjection capture; browser-only
  // mobile restrictions must not describe its capabilities or room permissions.
  if (nativeAndroid) return undefined;
  if (/Android|iPhone|iPad|iPod|Mobi/i.test(userAgent)) return { kind: 'notice', message: t('join.mobileNotice') };
  if (/Macintosh|Mac OS X/i.test(userAgent)) return { kind: 'block', message: t('join.unsupported') };
  const blockedChromium = /OPR\/|Opera|Brave|Vivaldi|YaBrowser|SamsungBrowser|UCBrowser|DuckDuckGo|Whale/i.test(userAgent)
    || Boolean((navigator as Navigator & { brave?: unknown }).brave);
  const isEdge = /Edg\/\d+/i.test(userAgent);
  const isChrome = /Chrome\/\d+/i.test(userAgent) && !blockedChromium;
  if (!/Windows NT 10\.0/i.test(userAgent) || blockedChromium || (!isChrome && !isEdge)) return { kind: 'block', message: t('join.unsupported') };
  return undefined;
}

function isTerminalMeetingFailure(reason: unknown): boolean {
  if (!(reason instanceof ApiRequestError)) return false;
  const code = reason.details?.error.code;
  return reason.status === 404
    || reason.status === 410
    || code === 'MEETING_NOT_FOUND'
    || code === 'MEETING_EXPIRED';
}

export function JoinLobbyPage({ slug }: JoinLobbyPageProps) {
  const { t } = useI18n();
  const { host: clientHost } = useClientHost();
  const navigate = useNavigate();
  const formId = useId();
  const [nickname, setNickname] = useState('');
  const [meetingPassword, setMeetingPassword] = useState('');
  const [error, setError] = useState<string>();
  const [joined, setJoined] = useState<JoinedMeeting>();
  const [isJoining, setIsJoining] = useState(false);
  const [previewCleanup, setPreviewCleanup] = useState<(() => void) | null>(null);
  const [summaryState, setSummaryState] = useState<LobbySummaryState>({ kind: 'loading' });
  const summaryRequestGeneration = useRef(0);
  const notice = clientNotice(t, clientHost?.platform === 'android');
  const registerCleanup = useCallback((cleanup: (() => void) | null) => setPreviewCleanup(() => cleanup), []);
  const readySummary = summaryState.kind === 'ready' && summaryState.slug === slug ? summaryState.summary : undefined;
  const passwordRequired = Boolean(readySummary?.requiresPassword);

  const loadSummary = useCallback(async () => {
    const generation = ++summaryRequestGeneration.current;
    setSummaryState({ kind: 'loading' });
    try {
      const summary = await apiRequest<MeetingSummary>(
        `/meetings/${encodeURIComponent(slug)}`,
        MeetingSummarySchema
      );
      if (generation !== summaryRequestGeneration.current) return;
      if (summary.status === 'ended' || summary.status === 'expired') {
        navigate('/create', { replace: true });
        return;
      }
      setSummaryState({ kind: 'ready', slug, summary });
    } catch (reason) {
      if (generation !== summaryRequestGeneration.current) return;
      if (isTerminalMeetingFailure(reason)) {
        navigate('/create', { replace: true });
        return;
      }
      setSummaryState({ kind: 'unavailable' });
    }
  }, [navigate, slug]);

  useEffect(() => {
    void loadSummary();
    return () => { summaryRequestGeneration.current++; };
  }, [loadSummary]);

  if (joined?.slug === slug) return <MeetingRoomPage
    slug={slug}
    meetingName={joined.meetingName}
    join={joined.response}
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
      setJoined({ slug, meetingName: readySummary?.name ?? '', response }); setMeetingPassword('');
    } catch (reason) {
      if (isTerminalMeetingFailure(reason)) {
        previewCleanup?.();
        navigate('/create', { replace: true });
        return;
      }
      setError(reason instanceof ApiRequestError ? apiErrorText(reason, t, 'join.failed') : t('join.failed'));
    }
    finally { setIsJoining(false); }
  }

  if (!readySummary) return <TaskPageLayout className="task-meeting-page" icon={<MonitorUp size={22} />} eyebrow={t('join.eyebrow')} title={t('join.heading')} lede={t('join.lede')}>
    <p className={summaryState.kind === 'loading' ? 'message' : 'message error'} role={summaryState.kind === 'loading' ? 'status' : 'alert'}>
      {summaryState.kind === 'loading' ? t('join.loading') : t('join.lookupFailed')}
    </p>
    {summaryState.kind === 'unavailable' && <button type="button" className="secondary" onClick={() => void loadSummary()}>{t('join.retry')}</button>}
  </TaskPageLayout>;

  const roomStatus = readySummary.status === 'active' ? t('current.status.active')
    : readySummary.status === 'grace' ? t('current.status.grace') : t('current.status.created');
  return <TaskPageLayout
    className="task-meeting-page join-meeting-page"
    icon={<MonitorUp size={22} />}
    eyebrow={t('join.eyebrow')}
    title={readySummary.name}
    lede={readySummary.isFull ? `${roomStatus} · ${t('current.full')}` : roomStatus}
    surfaceTitle={t('join.form')}
    contextLabel={t('join.selectedMeeting')}
    context={<p className="task-context-note">{t('join.mutedHint')}</p>}
  >
    {notice && <p className={`message ${notice.kind === 'block' ? 'error' : 'notice'}`} role={notice.kind === 'block' ? 'alert' : 'status'}>{notice.message}</p>}
    <form id={formId} aria-label={t('join.form')} onSubmit={join} noValidate>
      <label>{t('join.nickname')}<input aria-label={t('join.nickname')} value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={40} autoComplete="name" /></label>
      <label><span>{t('join.password')} (<span className="optional">{passwordRequired ? t('join.required') : t('common.optional')}</span>)</span><span className="task-password"><LockKeyhole size={18} aria-hidden="true" /><input aria-label={t('join.password')} placeholder={t('join.passwordPlaceholder')} aria-required={passwordRequired} required={passwordRequired} type="password" value={meetingPassword} onChange={(event) => setMeetingPassword(event.target.value)} maxLength={128} autoComplete="current-password" /></span></label>
      {error && <p className="message error" role="alert">{error}</p>}
    </form>
    <details className="device-check-disclosure" onToggle={(event) => { if (!event.currentTarget.open) previewCleanup?.(); }}>
      <summary><Headphones size={20} aria-hidden="true" /><span><strong>{t('device.heading')}</strong><small>{t('device.audioEquipment')}</small></span><ChevronRight size={18} aria-hidden="true" /></summary>
      <DeviceCheck onCleanupReady={registerCleanup} />
    </details>
    <p className="task-mobile-note">{t('join.mutedHint')}</p>
    <button className="task-submit" type="submit" form={formId} disabled={isJoining || notice?.kind === 'block'}>{isJoining ? t('join.submitting') : t('join.submit')}<ArrowRight size={18} aria-hidden="true" /></button>
  </TaskPageLayout>;
}
