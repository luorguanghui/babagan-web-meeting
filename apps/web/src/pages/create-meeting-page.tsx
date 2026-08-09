import { CreateMeetingResponseSchema, type CreateMeetingRequest, type CreateMeetingResponse } from '@meeting/contracts';
import { type FormEvent, useState } from 'react';

import { ApiRequestError, apiRequest } from '../api/client.js';
import { apiErrorText, useI18n } from '../i18n/i18n.js';

export function CreateMeetingPage() {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [meetingPassword, setMeetingPassword] = useState('');
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<CreateMeetingResponse>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  async function createMeeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined); setCopied(false);
    if (!name.trim()) return setError(t('create.nameRequired'));
    if (!adminPassword) return setError(t('create.adminRequired'));
    if (meetingPassword && meetingPassword.length < 6) return setError(t('create.passwordLength'));
    const body: CreateMeetingRequest = { name: name.trim(), adminPassword, ...(meetingPassword ? { meetingPassword } : {}) };
    setIsSubmitting(true);
    try {
      const response = await apiRequest<CreateMeetingResponse>('/meetings', CreateMeetingResponseSchema, { method: 'POST', body: JSON.stringify(body) });
      setCreated(response);
      setAdminPassword('');
      setMeetingPassword('');
    } catch (reason) {
      setError(reason instanceof ApiRequestError ? apiErrorText(reason, t, 'create.failed') : t('create.failed'));
    } finally { setIsSubmitting(false); }
  }

  async function copyLink() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.joinUrl); setCopied(true); }
    catch { setError(t('create.copyFailed')); }
  }

  return <main className="shell"><section className="panel" aria-labelledby="create-heading">
    <p className="eyebrow">{t('create.eyebrow')}</p><h1 id="create-heading">{t('create.heading')}</h1>
    <p className="lede">{t('create.lede')}</p>
    <form onSubmit={createMeeting} noValidate>
      <label>{t('create.name')}<input aria-label={t('create.name')} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="off" /></label>
      <label>{t('create.adminPassword')}<input aria-label={t('create.adminPassword')} type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} maxLength={256} autoComplete="new-password" /></label>
      <label>{t('create.meetingPassword')} <span className="optional">{t('common.optional')}</span><input aria-label={t('create.meetingPassword')} type="password" value={meetingPassword} onChange={(event) => setMeetingPassword(event.target.value)} maxLength={128} autoComplete="new-password" /></label>
      {error && <p className="message error" role="alert">{error}</p>}
      <button type="submit" disabled={isSubmitting}>{isSubmitting ? t('create.submitting') : t('create.submit')}</button>
    </form>
    {created && <section className="created-link" aria-label={t('create.linkRegion')}><p className="eyebrow">{t('create.shareLink')}</p><output>{created.joinUrl}</output><a className="host-link" href={created.joinUrl}>{t('create.enterHost')}</a><button type="button" className="secondary" onClick={copyLink}>{t('create.copyLink')}</button>{copied && <p className="message success" role="status">{t('create.copied')}</p>}</section>}
  </section></main>;
}
