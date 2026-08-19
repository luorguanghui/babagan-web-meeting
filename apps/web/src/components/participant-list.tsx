import { useI18n } from '../i18n/i18n.js';
import type { MeetingParticipant } from '../meeting/room-controller.js';

export function ParticipantList({ participants }: { participants: MeetingParticipant[] }) {
  const { t } = useI18n();
  return <section className="participant-list" aria-labelledby="participant-heading">
    <h2 id="participant-heading">{t('participants.heading', { count: participants.length })}</h2>
    <ul aria-label={t('participants.label')}>
      {participants.slice(0, 5).map((participant) => {
        const microphone = participant.microphoneEnabled ? t('participants.microphoneOn').toLowerCase() : t('participants.microphoneMuted');
        const label = t('participants.itemLabel', { name: participant.name, you: participant.isLocal ? 1 : 0, microphone });
        return <li key={participant.identity} aria-label={label}>
          <span>{participant.name}{participant.isLocal && ` (${t('participants.you')})`}</span>
          <span>{participant.microphoneEnabled ? t('participants.microphoneOn') : t('participants.muted')}</span>
        </li>;
      })}
    </ul>
  </section>;
}
