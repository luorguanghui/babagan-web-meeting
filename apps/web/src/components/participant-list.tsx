import { useI18n } from '../i18n/i18n.js';
import { Crown, Mic, MicOff, Monitor } from 'lucide-react';
import type { MeetingParticipant } from '../meeting/room-controller.js';

export function ParticipantList({ participants, localHostIdentity }: { participants: MeetingParticipant[]; localHostIdentity?: string }) {
  const { t } = useI18n();
  return <section className="participant-list" aria-labelledby="participant-heading">
    <div className="participant-heading-row">
      <h2 id="participant-heading" aria-label={t('participants.heading', { count: participants.length })}>{t('participants.onlineTogether')}</h2>
      <span className="participant-count" aria-hidden="true">{t('participants.onlineCount', { count: participants.length })}</span>
    </div>
    <ul aria-label={t('participants.label')}>
      {participants.map((participant, index) => {
        const microphone = participant.microphoneEnabled ? t('participants.microphoneOn').toLowerCase() : t('participants.microphoneMuted');
        const label = t('participants.itemLabel', { name: participant.name, you: participant.isLocal ? 1 : 0, microphone });
        const isHost = participant.isLocal && participant.identity === localHostIdentity;
        return <li key={participant.identity} aria-label={label} data-sharing={participant.isSharing || undefined}>
          <span className="participant-avatar" data-tone={index % 4} data-sharing={participant.isSharing || undefined} aria-hidden="true">{Array.from(participant.name.trim())[0]?.toUpperCase()}</span>
          <div className="participant-identity">
            <div className="participant-name-row">
              <span className="participant-name">{participant.name}{participant.isLocal && ` (${t('participants.you')})`}</span>
              {isHost && <span className="participant-host-badge"><Crown aria-hidden="true" size={14} />{t('participants.host')}</span>}
            </div>
            <span className="participant-detail" data-sharing={participant.isSharing || undefined}>
              {participant.isSharing && <Monitor aria-hidden="true" size={16} />}
              {participant.isSharing ? t('participants.sharing') : microphone}
            </span>
          </div>
          <span className="participant-microphone" data-muted={!participant.microphoneEnabled} aria-hidden="true">{participant.microphoneEnabled ? <Mic size={19} /> : <MicOff size={19} />}</span>
        </li>;
      })}
    </ul>
  </section>;
}
