import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { HostMenu } from './host-menu.js';

afterEach(cleanup);

it('restores an idle share grant when the host rejoins and keeps it visible across starts and stops', async () => {
  const revoke = vi.fn(async () => {});
  const props = {
    authorized: true, authorizeHost: async () => {}, onGrantShare: vi.fn(),
    onRevokeShare: revoke, onKick: vi.fn(), onEndMeeting: vi.fn(),
    participants: [
      { identity: 'a', name: 'Ada', isSharing: false, canShareScreen: true },
      { identity: 'b', name: 'Bob', isSharing: false, canShareScreen: false }
    ]
  };
  const view = render(<HostMenu {...props} />);
  expect(screen.getByRole('button', { name: 'Revoke screen sharing from Ada' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Grant screen sharing to Bob' })).toBeDisabled();
  view.rerender(<HostMenu {...props} participants={props.participants.map(p => ({ ...p, isSharing: p.identity === 'a' }))} />);
  view.rerender(<HostMenu {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Revoke screen sharing from Ada' }));
  expect(revoke).toHaveBeenCalledOnce();
});
