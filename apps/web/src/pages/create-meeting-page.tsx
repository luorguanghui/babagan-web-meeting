import {
  CreateMeetingResponseSchema,
  type CreateMeetingRequest,
  type CreateMeetingResponse
} from '@meeting/contracts';
import { type FormEvent, useState } from 'react';

import { ApiRequestError, apiNoContent, apiRequest } from '../api/client.js';
import { CurrentMeetingCard } from '../components/current-meeting-card.js';
import { TaskPageLayout } from '../components/task-page-layout.js';
import { apiErrorText, useI18n } from '../i18n/i18n.js';
import { useOpenMeetings } from './use-open-meetings.js';
import './create-meeting-page.css';

export function CreateMeetingPage() {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [meetingPassword, setMeetingPassword] = useState('');
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<CreateMeetingResponse>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const open = useOpenMeetings();

  async function createMeeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined); setCopied(false);
    if (open.atCapacity) return setError(t('error.MEETING_LIMIT_REACHED'));
    if (!name.trim()) return setError(t('create.nameRequired'));
    if (!adminPassword) return setError(t('create.adminRequired'));
    if (meetingPassword && meetingPassword.length < 6) return setError(t('create.passwordLength'));
    const body: CreateMeetingRequest = { name: name.trim(), adminPassword, ...(meetingPassword ? { meetingPassword } : {}) };
    setIsSubmitting(true);
    try {
      const response = await apiRequest<CreateMeetingResponse>('/meetings', CreateMeetingResponseSchema, { method: 'POST', body: JSON.stringify(body) });
      setCreated(response);
      open.add({
        slug: response.slug,
        name: body.name,
        status: 'created',
        joinUrl: response.joinUrl,
        requiresPassword: Boolean(body.meetingPassword),
        isFull: false
      });
      setAdminPassword('');
      setMeetingPassword('');
      void open.refresh();
    } catch (reason) {
      setError(reason instanceof ApiRequestError ? apiErrorText(reason, t, 'create.failed') : t('create.failed'));
      if (reason instanceof ApiRequestError && reason.details?.error.code === 'MEETING_LIMIT_REACHED') void open.refresh();
    } finally { setIsSubmitting(false); }
  }

  async function copyLink() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.joinUrl); setCopied(true); }
    catch { setError(t('create.copyFailed')); }
  }

  async function endMeeting(slug: string, adminPassword: string) {
    await apiNoContent(`/meetings/${encodeURIComponent(slug)}/admin-end`, {
      method: 'POST', body: JSON.stringify({ adminPassword })
    });
  }

  const context = <div className="task-context-content">
    <section className="open-meetings-list" aria-label={t('open.heading')} aria-busy={open.loading}>
      <h2>{t('open.heading')}</h2>
      {open.loaded && <p className="open-meetings-count">{t('open.capacity', { count: open.meetings.length, max: open.maxOpenMeetings })}</p>}
      {open.loading && !open.loaded && <p role="status">{t('open.loading')}</p>}
      {open.loaded && !open.meetings.length && <p>{t('open.empty')}</p>}
      {open.meetings.map(meeting => <CurrentMeetingCard key={meeting.slug} meeting={meeting} onEnd={password => endMeeting(meeting.slug, password)} onEnded={() => {
        open.remove(meeting.slug);
        setCreated(value => value?.slug === meeting.slug ? undefined : value);
        void open.refresh();
      }} />)}
      {open.meetings.some(meeting => meeting.unavailable) && <p className="message notice">{t('open.unavailableHint')} <button type="button" className="text-button" disabled={open.loading} onClick={() => void open.refresh()}>{t('current.retry')}</button></p>}
      {open.failed && <p className="message error" role="alert">{t('open.lookupFailed')} <button type="button" className="text-button" onClick={() => void open.refresh()}>{t('current.retry')}</button></p>}
    </section>
  </div>;

  return <TaskPageLayout className="create-meeting-page" eyebrow={t('create.eyebrow')} title={t('create.heading')} lede={t('create.lede')} context={context}>
    <form aria-label={t('create.submit')} onSubmit={createMeeting} noValidate>
      <label>{t('create.name')}<input aria-label={t('create.name')} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="off" /></label>
      <label>{t('create.adminPassword')}<input aria-label={t('create.adminPassword')} type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} maxLength={256} autoComplete="new-password" /></label>
      <label>{t('create.meetingPassword')} <span className="optional">{t('common.optional')}</span><input aria-label={t('create.meetingPassword')} type="password" value={meetingPassword} onChange={(event) => setMeetingPassword(event.target.value)} maxLength={128} autoComplete="new-password" /></label>
      {error && <p className="message error" role="alert">{error}</p>}
      {open.atCapacity && <p className="message notice" role="status">{t('error.MEETING_LIMIT_REACHED')}</p>}
      <button type="submit" disabled={isSubmitting || open.atCapacity}>{isSubmitting ? t('create.submitting') : t('create.submit')}</button>
    </form>
    {created && <section className="created-link" aria-label={t('create.linkRegion')}><p className="eyebrow">{t('create.shareLink')}</p><output>{created.joinUrl}</output><a className="host-link" href={created.joinUrl}>{t('create.enterHost')}</a><button type="button" className="secondary" onClick={copyLink}>{t('create.copyLink')}</button>{copied && <p className="message success" role="status">{t('create.copied')}</p>}</section>}
  </TaskPageLayout>;
}
