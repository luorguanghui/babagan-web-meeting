import { type FormEvent, useState } from 'react';

import { ApiRequestError } from '../api/client.js';
import { apiErrorText, useI18n } from '../i18n/i18n.js';

export function AdminEndMeetingForm(props: {
  onEnd: (adminPassword: string) => Promise<void>;
  onEnded?: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [adminPassword, setAdminPassword] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    if (!adminPassword) return setError(t('adminEnd.passwordRequired'));
    setSubmitting(true);
    try {
      await props.onEnd(adminPassword);
      setAdminPassword('');
      props.onEnded?.();
    } catch (reason) {
      setError(reason instanceof ApiRequestError
        ? apiErrorText(reason, t, 'adminEnd.failed')
        : t('adminEnd.failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return <form className={props.compact ? 'admin-end-form compact' : 'admin-end-form'} onSubmit={submit}>
    <label>{t('adminEnd.password')}<input
      aria-label={t('adminEnd.password')}
      type="password"
      value={adminPassword}
      maxLength={256}
      autoComplete="current-password"
      onChange={(event) => setAdminPassword(event.target.value)}
    /></label>
    {error && <p className="message error" role="alert">{error}</p>}
    <button type="submit" className="danger" disabled={submitting}>
      {submitting ? t('adminEnd.ending') : t('adminEnd.end')}
    </button>
  </form>;
}
