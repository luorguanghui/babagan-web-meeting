import type { OpenMeeting } from '@meeting/contracts';
import { useId } from 'react';

import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { AdminEndMeetingForm } from './admin-end-meeting-form.js';

export function CurrentMeetingCard(props: {
  meeting: OpenMeeting;
  onEnd: (adminPassword: string) => Promise<void>;
  onEnded: () => void;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const nameId = useId();
  return <section className="current-meeting-card" aria-labelledby={`${headingId} ${nameId}`}>
    <p className="eyebrow">{t('current.eyebrow')}</p>
    <h2 id={headingId}>{t('current.heading')}</h2>
    <h3 id={nameId}>{props.meeting.name}</h3>
    <div className="current-meeting-meta">
      <span>{t(`current.status.${props.meeting.status}` as MessageKey)}</span>
      <span>{props.meeting.requiresPassword ? t('current.passwordRequired') : t('current.noPassword')}</span>
      {props.meeting.unavailable ? <span>{t('open.unavailable')}</span> : props.meeting.isFull && <span>{t('current.full')}</span>}
    </div>
    {props.meeting.isFull || props.meeting.unavailable
      ? <span className="host-link disabled-link" aria-disabled="true">{props.meeting.unavailable ? t('open.unavailable') : t('current.join')}</span>
      : <a className="host-link" href={`/m/${encodeURIComponent(props.meeting.slug)}`}>{t('current.join')}</a>}
    <AdminEndMeetingForm onEnd={props.onEnd} onEnded={props.onEnded} />
  </section>;
}
