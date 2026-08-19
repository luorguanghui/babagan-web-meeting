import type { CurrentMeeting } from '@meeting/contracts';

import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { AdminEndMeetingForm } from './admin-end-meeting-form.js';

export function CurrentMeetingCard(props: {
  meeting: CurrentMeeting;
  onEnd: (adminPassword: string) => Promise<void>;
  onEnded: () => void;
}) {
  const { t } = useI18n();
  return <section className="current-meeting-card" aria-labelledby="current-meeting-heading">
    <p className="eyebrow">{t('current.eyebrow')}</p>
    <h2 id="current-meeting-heading">{t('current.heading')}</h2>
    <h3>{props.meeting.name}</h3>
    <div className="current-meeting-meta">
      <span>{t(`current.status.${props.meeting.status}` as MessageKey)}</span>
      <span>{props.meeting.requiresPassword ? t('current.passwordRequired') : t('current.noPassword')}</span>
      {props.meeting.isFull && <span>{t('current.full')}</span>}
    </div>
    {props.meeting.isFull
      ? <span className="host-link disabled-link" aria-disabled="true">{t('current.join')}</span>
      : <a className="host-link" href={props.meeting.joinUrl}>{t('current.join')}</a>}
    <AdminEndMeetingForm onEnd={props.onEnd} onEnded={props.onEnded} />
  </section>;
}
