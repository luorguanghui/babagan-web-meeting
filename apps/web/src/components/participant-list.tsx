import { useI18n } from '../i18n/i18n.js';
import { Mic, MicOff } from 'lucide-react';
import type { MeetingParticipant } from '../meeting/room-controller.js';

export function ParticipantList({ participants }: { participants: MeetingParticipant[] }) {
  const { t } = useI18n();
  return <section className="participant-list" aria-labelledby="participant-heading">
    <h2 id="participant-heading">{t('participants.heading', { count: participants.length })}</h2>
    <ul aria-label={t('participants.label')}>
      {participants.map((participant, index) => {
        const microphone = participant.microphoneEnabled ? t('participants.microphoneOn').toLowerCase() : t('participants.microphoneMuted');
        const label = t('participants.itemLabel', { name: participant.name, you: participant.isLocal ? 1 : 0, microphone });
        return <li key={participant.identity} aria-label={label}>
          <span className="participant-avatar" data-tone={index % 4} aria-hidden="true">{Array.from(participant.name.trim())[0]?.toUpperCase()}</span>
          <div className="participant-identity"><span className="participant-name">{participant.name}{participant.isLocal && ` (${t('participants.you')})`}</span>
            <span className="participant-detail" data-sharing={participant.isSharing || undefined}>{participant.isSharing ? t('participants.sharing') : microphone}</span>
          </div>
          <span className="participant-microphone" data-muted={!participant.microphoneEnabled} aria-hidden="true">{participant.microphoneEnabled ? <Mic size={19} /> : <MicOff size={19} />}</span>
        </li>;
      })}
    </ul>
  </section>;
}
