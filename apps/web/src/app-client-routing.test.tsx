import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';

const bridge = vi.hoisted(() => ({ platform: undefined as 'windows' | 'android' | undefined }));
vi.mock('./client/client-host.js', () => ({
  useClientHost: () => ({ host: bridge.platform ? { platform: bridge.platform } : undefined, joined: false, update: 'idle' }),
  checkClientUpdate: vi.fn(),
}));
vi.mock('./pages/client-workspace-page.js', () => ({ ClientWorkspacePage: () => <h1>Meeting workspace</h1> }));
vi.mock('./pages/create-meeting-page.js', () => ({ CreateMeetingPage: () => <h1>Create a meeting</h1> }));
vi.mock('./pages/join-lobby-page.js', () => ({ JoinLobbyPage: ({ slug }: { slug: string }) => <h1>Join {slug}</h1> }));

import { App } from './app.js';

function Location() { const value = useLocation(); return <output data-testid="location">{value.pathname + value.search}</output>; }
function open(path: string) { return render(<MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter>); }
beforeEach(() => {
  bridge.platform = undefined;
  localStorage.setItem('babagan.locale', 'en');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schema: 1, releases: {} })));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

it.each(['windows', 'android'] as const)('starts the %s app in its workspace before host info arrives', platform => {
  bridge.platform = platform;
  open('/');
  expect(screen.getByRole('heading', { name: 'Meeting workspace' })).toBeVisible();
  expect(screen.getByTestId('location')).toHaveTextContent('/client');
  expect(screen.queryByRole('link', { name: 'Downloads' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Windows sharing' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Babagan Workspace' })).toHaveAttribute('href', '/client');
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps the public homepage and downloads available to browser visitors', async () => {
  open('/');
  expect(screen.getByRole('heading', { name: 'Good company. One click away.' })).toBeVisible();
  expect(screen.getByTestId('location')).toHaveTextContent('/');
  expect(screen.getAllByRole('link', { name: 'Downloads' }).length).toBeGreaterThan(0);
  expect(await screen.findAllByText('Not released yet')).toHaveLength(2);
});

it('does not redirect a native invitation away from its selected meeting', () => {
  bridge.platform = 'windows';
  open('/m/invited-room?from=invitation');
  expect(screen.getByRole('heading', { name: 'Join invited-room' })).toBeVisible();
  expect(screen.getByTestId('location')).toHaveTextContent('/m/invited-room?from=invitation');
  expect(screen.queryByRole('link', { name: 'Downloads' })).not.toBeInTheDocument();
});

it('returns native users to the workspace from the component installation page', () => {
  bridge.platform = 'windows';
  open('/native');
  expect(screen.getByRole('heading', { name: 'Meeting workspace' })).toBeVisible();
  expect(screen.getByTestId('location')).toHaveTextContent('/client');
});
