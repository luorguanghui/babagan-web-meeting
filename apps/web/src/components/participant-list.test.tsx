import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ParticipantList } from './participant-list.js';
afterEach(cleanup);
it('keeps every participant, including the sixth, in the persistent roster', () => {
  render(<ParticipantList participants={Array.from({ length: 8 }, (_, index) => ({ identity: String(index), name: `Member ${index}`, isLocal: index === 0, microphoneEnabled: index % 2 === 0, isSharing: index === 6 }))} />);
  expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(8);
  expect(screen.getByText('Member 6')).toBeInTheDocument();
  expect(screen.getByText('Sharing screen')).toBeInTheDocument();
});
