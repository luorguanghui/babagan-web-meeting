import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import type { ClientSnapshot } from '../client/client-host.js';
import type { ClientHost } from '../client/host-bridge.js';
import { LanguageProvider } from '../i18n/i18n.js';
import { ClientWorkspacePage } from './client-workspace-page.js';

const client = vi.hoisted(() => ({ snapshot: { joined: false, update: 'idle' } as ClientSnapshot, check: vi.fn(async () => {}) }));
vi.mock('../client/client-host.js', () => ({ useClientHost: () => client.snapshot, checkClientUpdate: client.check }));
const slug = 'abcdefghijklmnopqrstuv';
const meeting = { slug, name: 'Weekly project room', status: 'active', joinUrl: `https://meet.babagan.cloud/m/${slug}`, requiresPassword: false, isFull: false };
function host(platform: 'windows' | 'android'): ClientHost {
  return { platform, request: async <T,>() => ({} as T), subscribe: () => () => {} };
}
function Destination() { return <output aria-label="Navigation destination">{useLocation().pathname}</output>; }
function show(locale: 'en' | 'zh-CN' = 'en') {
  return render(<LanguageProvider initialLocale={locale}><MemoryRouter initialEntries={['/client']}><Routes>
    <Route path="/client" element={<ClientWorkspacePage />} />
    <Route path="/m/:slug" element={<Destination />} /><Route path="/create" element={<Destination />} />
  </Routes></MemoryRouter></LanguageProvider>);
}
beforeEach(() => {
  client.snapshot = { joined: false, update: 'idle' }; client.check.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ meetings: [], maxOpenMeetings: 3 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('opens the actual lobby route for a pasted invitation without joining or requesting devices', async () => {
  const getUserMedia = vi.fn(), getDisplayMedia = vi.fn();
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia, getDisplayMedia } });
  show();
  await screen.findByText('No meeting is open right now');
  fireEvent.change(screen.getByLabelText('Meeting link or ID'), { target: { value: `${window.location.origin}/meetings/${slug}` } });
  fireEvent.click(screen.getByRole('button', { name: 'Join meeting' }));
  expect(screen.getByLabelText('Navigation destination')).toHaveTextContent(`/m/${slug}`);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith('/api/v1/meetings/open', expect.objectContaining({ credentials: 'include' }));
  expect(getUserMedia).not.toHaveBeenCalled(); expect(getDisplayMedia).not.toHaveBeenCalled();
});

it('keeps unsafe input on the workspace and lets a corrected meeting ID navigate', async () => {
  show('zh-CN'); await screen.findByText('目前没有开放的会议');
  const input = screen.getByLabelText('会议链接或 ID');
  fireEvent.change(input, { target: { value: `https://example.test/m/${slug}` } });
  fireEvent.click(screen.getByRole('button', { name: '加入会议' }));
  expect(screen.getByRole('alert')).toHaveTextContent('当前 Babagan 站点'); expect(input).toHaveFocus();
  expect(screen.queryByLabelText('Navigation destination')).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: `  ${slug}  ` } });
  fireEvent.click(screen.getByRole('button', { name: '加入会议' }));
  expect(screen.getByLabelText('Navigation destination')).toHaveTextContent(`/m/${slug}`);
});

it('offers the validated current meeting without trusting its joinUrl or automatically entering it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ meetings: [{ ...meeting, joinUrl: 'https://untrusted.example/redirect', requiresPassword: true }], maxOpenMeetings: 3 })));
  show();
  expect(await screen.findByRole('heading', { name: meeting.name })).toBeVisible();
  expect(screen.getByText('Password required')).toBeVisible();
  const link = screen.getByRole('link', { name: 'Open meeting' });
  expect(link).toHaveAttribute('href', `/m/${slug}`);
  expect(screen.queryByLabelText('Navigation destination')).not.toBeInTheDocument();
  fireEvent.click(link); expect(screen.getByLabelText('Navigation destination')).toHaveTextContent(`/m/${slug}`);
});

it('recovers a failed lookup and keeps a full meeting from being entered by the shortcut', async () => {
  const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(Response.json({ meetings: [{ ...meeting, isFull: true }], maxOpenMeetings: 3 }));
  vi.stubGlobal('fetch', request); show();
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { name: meeting.name })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Meeting full' })).toBeDisabled();
  expect(screen.queryByRole('link', { name: 'Open meeting' })).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(2);
});

it('keeps creation available from an empty workspace', async () => {
  show(); await screen.findByText('No meeting is open right now');
  fireEvent.click(screen.getByRole('link', { name: 'Create meeting' }));
  expect(screen.getByLabelText('Navigation destination')).toHaveTextContent('/create');
});

it('does not label a detected Windows bridge as ready before capabilities are reported', async () => {
  client.snapshot = { host: host('windows'), joined: false, update: 'idle' };
  show(); await screen.findByText('No meeting is open right now');
  expect(screen.getByRole('heading', { name: 'Sharing capability not confirmed' })).toBeVisible();
  expect(screen.queryByText('Native Windows screen capture')).not.toBeInTheDocument();
  expect(screen.getByText('Version not confirmed')).toBeVisible();
});

it('reports Android limits from host info and runs an explicit update check', async () => {
  client.snapshot = { host: host('android'), info: { platform: 'android', appVersion: '0.1.1', protocol: 1, screenCapture: true, systemAudio: false }, joined: false, update: 'current' };
  show(); await screen.findByText('No meeting is open right now');
  expect(screen.getByRole('heading', { name: 'Android screen capture · up to 30 fps' })).toBeVisible();
  expect(screen.getByText(/system sound is not included/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  await waitFor(() => expect(client.check).toHaveBeenCalledOnce());
});

it('labels an ordinary web session as browser capture without native or client-update claims', async () => {
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getDisplayMedia: vi.fn() } });
  show(); await screen.findByText('No meeting is open right now');
  expect(screen.getByText('Browser workspace')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Browser screen capture' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Check for updates' })).not.toBeInTheDocument();
});

it('shows 60 fps only when the Android client reports the new capture capability', async () => {
  client.snapshot = { host: host('android'), info: { platform: 'android', appVersion: '0.1.2', protocol: 1, screenCapture: true, maxScreenFrameRate: 60, systemAudio: false }, joined: false, update: 'current' };
  show(); await screen.findByText('No meeting is open right now');
  expect(screen.getByRole('heading', { name: 'Android screen capture · up to 60 fps' })).toBeVisible();
});

it('describes a downloaded Android update as awaiting system installation, not a restart', async () => {
  client.snapshot = { host: host('android'), info: { platform: 'android', appVersion: '0.1.1', protocol: 1, screenCapture: true }, joined: false, update: 'ready' };
  show(); await screen.findByText('No meeting is open right now');
  expect(screen.getByRole('status')).toHaveTextContent('Update ready; Android will ask to install when idle');
  expect(screen.getByRole('status')).not.toHaveTextContent('next launch');
});

it('shows a meeting-deferred update and prevents an update check while joined', async () => {
  client.snapshot = { host: host('android'), joined: true, update: 'ready' };
  show('zh-CN'); await screen.findByText('目前没有开放的会议');
  expect(screen.getByRole('status')).toHaveTextContent('会议');
  expect(screen.getByRole('button', { name: '检查更新' })).toBeDisabled();
  expect(client.check).not.toHaveBeenCalled();
});
