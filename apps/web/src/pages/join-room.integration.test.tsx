import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installBrowserFakes } from '../test/browser-fakes.js';

vi.mock('./meeting-room-page.js', () => ({
  MeetingRoomPage: ({ onTerminal }: { onTerminal(reason: 'expired'): void }) => <main>
    <h1>Joined room</h1><button type="button" onClick={() => onTerminal('expired')}>Simulate expired meeting</button>
  </main>
}));

import { JoinLobbyPage } from './join-lobby-page.js';

const slug = 'meeting-slug-which-is-long-enough';

afterEach(() => { vi.unstubAllGlobals(); });

describe('lobby to room integration', () => {
  it('enters the meeting room after join and routes a terminal meeting back to the lobby', async () => {
    installBrowserFakes();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      participantIdentity: 'p-1', participantName: 'Ada', livekitUrl: 'wss://rtc.example', token: 'token',
      meetingExpiresAt: 1_725_000_000_000, permissions: { publishSources: ['microphone'] }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    render(<MemoryRouter initialEntries={[`/m/${slug}`]}><JoinLobbyPage slug={slug} /></MemoryRouter>);

    await userEvent.type(screen.getByLabelText('Nickname'), 'Ada');
    await userEvent.click(screen.getByRole('button', { name: 'Join muted' }));
    expect(await screen.findByRole('heading', { name: 'Joined room' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Simulate expired meeting' }));
    expect(await screen.findByRole('heading', { name: 'Ready when you are' })).toBeVisible();
  });
});
