import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ParticipantList } from './participant-list.js';
afterEach(cleanup);
it('keeps every participant, including the sixth, in the persistent roster', () => {
  render(<ParticipantList participants={Array.from({ length: 8 }, (_, index) => ({ identity: String(index), name: `Member ${index}`, isLocal: index === 0, microphoneEnabled: index % 2 === 0, isSharing: index === 6 }))} />);
  expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(8);
  expect(screen.getByRole('heading', { name: 'Participants (8)' })).toHaveTextContent('Together online');
  expect(screen.getByText('Member 6')).toBeInTheDocument();
  expect(screen.getByText('Sharing screen')).toBeInTheDocument();
});

it('shows a host badge only for the explicitly authorized local participant', () => {
  const participants = [
    { identity: 'self', name: 'Ada', isLocal: true, microphoneEnabled: false, isSharing: false },
    { identity: 'remote', name: 'Ben', isLocal: false, microphoneEnabled: true, isSharing: false }
  ];
  const { rerender } = render(<ParticipantList participants={participants} />);
  expect(screen.queryByText('Host')).not.toBeInTheDocument();

  rerender(<ParticipantList participants={participants} localHostIdentity="remote" />);
  expect(screen.queryByText('Host')).not.toBeInTheDocument();

  rerender(<ParticipantList participants={participants} localHostIdentity="self" />);
  expect(within(screen.getByRole('listitem', { name: 'Ada, you, microphone muted' })).getByText('Host')).toBeInTheDocument();
  expect(within(screen.getByRole('listitem', { name: 'Ben, microphone on' })).queryByText('Host')).not.toBeInTheDocument();
});
