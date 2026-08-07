import { CreateMeetingResponseSchema, type CreateMeetingRequest, type CreateMeetingResponse } from '@meeting/contracts';
import { type FormEvent, useState } from 'react';

import { ApiRequestError, apiRequest } from '../api/client.js';

export function CreateMeetingPage() {
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
    if (!name.trim()) return setError('Meeting name is required.');
    if (!adminPassword) return setError('Admin password is required.');
    if (meetingPassword && meetingPassword.length < 6) return setError('Meeting password must be at least 6 characters.');
    const body: CreateMeetingRequest = { name: name.trim(), adminPassword, ...(meetingPassword ? { meetingPassword } : {}) };
    setIsSubmitting(true);
    try {
      const response = await apiRequest<CreateMeetingResponse>('/meetings', CreateMeetingResponseSchema, { method: 'POST', body: JSON.stringify(body) });
      setCreated(response);
      setAdminPassword('');
      setMeetingPassword('');
    } catch (reason) {
      setError(reason instanceof ApiRequestError ? reason.message : 'The meeting could not be created.');
    } finally { setIsSubmitting(false); }
  }

  async function copyLink() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.joinUrl); setCopied(true); }
    catch { setError('Copy the link manually.'); }
  }

  return <main className="shell"><section className="panel" aria-labelledby="create-heading">
    <p className="eyebrow">Private web meeting</p><h1 id="create-heading">Create a meeting</h1>
    <p className="lede">Set up a small, short-lived room. Your admin password stays on this device only long enough to create it.</p>
    <form onSubmit={createMeeting} noValidate>
      <label>Meeting name<input aria-label="Meeting name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="off" /></label>
      <label>Admin password<input aria-label="Admin password" type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} maxLength={256} autoComplete="new-password" /></label>
      <label>Meeting password <span className="optional">optional</span><input aria-label="Meeting password" type="password" value={meetingPassword} onChange={(event) => setMeetingPassword(event.target.value)} maxLength={128} autoComplete="new-password" /></label>
      {error && <p className="message error" role="alert">{error}</p>}
      <button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Creating…' : 'Create meeting'}</button>
    </form>
    {created && <section className="created-link" aria-label="Meeting link"><p className="eyebrow">Share this link</p><output>{created.joinUrl}</output><a className="host-link" href={created.joinUrl}>Enter as host</a><button type="button" className="secondary" onClick={copyLink}>Copy link</button>{copied && <p className="message success" role="status">Link copied.</p>}</section>}
  </section></main>;
}
