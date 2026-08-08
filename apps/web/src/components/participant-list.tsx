import type { MeetingParticipant } from '../meeting/room-controller.js';

export function ParticipantList({ participants }: { participants: MeetingParticipant[] }) {
  return <section className="participant-list" aria-labelledby="participant-heading">
    <h2 id="participant-heading">Participants ({participants.length})</h2>
    <ul aria-label="Participants">
      {participants.slice(0, 5).map((participant) => {
        const microphone = participant.microphoneEnabled ? 'microphone on' : 'microphone muted';
        const label = `${participant.name}${participant.isLocal ? ', you' : ''}, ${microphone}`;
        return <li key={participant.identity} aria-label={label}>
          <span>{participant.name}{participant.isLocal && ' (You)'}</span>
          <span>{participant.microphoneEnabled ? 'Microphone on' : 'Muted'}</span>
        </li>;
      })}
    </ul>
  </section>;
}
