import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostMenu } from './host-menu.js';
import { MeetingDrawer } from './meeting-drawer.js';
import { MeetingTopBar } from './meeting-top-bar.js';

afterEach(cleanup);

describe('meeting workspace presentation', () => {
  it('keeps connection feedback visible and exposes diagnostics in the navigation rail', async () => {
    const onStats = vi.fn();
    render(<MeetingTopBar
      title="Project review" connection={<p role="status">Reconnecting</p>}
      transportLabel="P2P" participantCount={2} navigationLabel="Meeting navigation"
      participantLabel="Participants" settingsLabel="Settings" statsLabel="WebRTC data"
      onParticipants={() => undefined} onSettings={() => undefined} onStats={onStats}
      participantButtonRef={createRef()} settingsButtonRef={createRef()} statsButtonRef={createRef()}
    />);
    expect(screen.getByRole('status').closest('.sr-only')).toBeNull();
    const navigation = screen.getByRole('navigation', { name: 'Meeting navigation' });
    await userEvent.click(within(navigation).getByRole('button', { name: 'WebRTC data' }));
    expect(onStats).toHaveBeenCalledOnce();
  });

  it('removes modal background controls from the accessible tree and restores them on close', () => {
    const { rerender } = render(<main className="meeting-room">
      <section className="meeting-workspace"><button>Background action</button></section>
      <MeetingDrawer title="Settings" closeLabel="Close panel" onClose={() => undefined}>Settings content</MeetingDrawer>
    </main>);
    expect(screen.queryByRole('button', { name: 'Background action' })).not.toBeInTheDocument();
    rerender(<main className="meeting-room"><section className="meeting-workspace"><button>Background action</button></section></main>);
    expect(screen.getByRole('button', { name: 'Background action' })).toBeVisible();
  });

  it('shows each host-managed member once with status and scoped actions in that member row', async () => {
    const onRevokeShare = vi.fn().mockResolvedValue(undefined);
    const onKick = vi.fn().mockResolvedValue(undefined);
    render(<HostMenu
      unified authorized authorizeHost={async () => undefined}
      participants={[
        { identity: 'self', name: 'Ada', isSharing: false, isLocal: true, microphoneEnabled: false },
        { identity: 'ben', name: 'Ben', isSharing: true, isLocal: false, microphoneEnabled: true }
      ]}
      onGrantShare={async () => undefined} onRevokeShare={onRevokeShare} onKick={onKick} onEndMeeting={async () => undefined}
    />);
    const roster = screen.getByRole('list', { name: 'Participants' });
    expect(within(roster).getAllByRole('listitem')).toHaveLength(2);
    expect(within(roster).getAllByText('Ben')).toHaveLength(1);
    const ben = within(roster).getAllByRole('listitem')[1];
    expect(within(ben).getByText('Sharing screen')).toBeVisible();
    expect(within(ben).getByRole('img', { name: 'Microphone is on.' })).toBeVisible();
    expect(within(roster).getByRole('button', { name: 'Grant screen sharing to Ada' })).toBeDisabled();
    await userEvent.click(within(ben).getByRole('button', { name: 'Revoke screen sharing from Ben' }));
    expect(onRevokeShare).toHaveBeenCalledOnce();
    await userEvent.click(within(ben).getByRole('button', { name: 'Kick Ben' }));
    expect(onKick).toHaveBeenCalledWith('ben');
  });

  it('never exposes member-management controls without host authorization', () => {
    render(<HostMenu unified authorized={false} participants={[]}
      authorizeHost={async () => undefined} onGrantShare={async () => undefined}
      onRevokeShare={async () => undefined} onKick={async () => undefined} onEndMeeting={async () => undefined}
    />);
    expect(screen.queryByRole('button', { name: 'End meeting' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('unlocks the background and restores focus immediately while the exiting drawer remains inert', async () => {
    const trigger = createRef<HTMLButtonElement>();
    function ClosingDrawer() {
      const [exiting, setExiting] = useState(false);
      return <main className="meeting-room">
        <section><button ref={trigger}>Settings trigger</button></section>
        <MeetingDrawer title="Settings" closeLabel="Close panel" exiting={exiting}
          returnFocusRef={trigger} onClose={() => setExiting(true)}>Panel content</MeetingDrawer>
      </main>;
    }
    const { container } = render(<ClosingDrawer />);
    expect(screen.queryByRole('button', { name: 'Settings trigger' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container.querySelector('.meeting-drawer')).toHaveAttribute('data-state', 'exiting');
    expect(container.querySelector('.meeting-drawer')).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Settings trigger' })).toHaveFocus();
    expect(trigger.current?.closest('section')).not.toHaveAttribute('inert');
  });
});
