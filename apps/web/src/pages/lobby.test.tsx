import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CreateMeetingResponseSchema, RefreshParticipantTokenResponseSchema } from '@meeting/contracts';

import { apiNoContent, apiRequest } from '../api/client.js';
import { App } from '../app.js';
import { installBrowserFakes } from '../test/browser-fakes.js';

const slug = 'meeting-slug-which-is-long-enough';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window.navigator as Navigator & { brave?: unknown }).brave;
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(window.navigator, 'languages', { configurable: true, value: ['en-US'] });
});

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

function success(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('meeting creation', () => {
  it('follows a Chinese browser language and can switch back to English', async () => {
    installBrowserFakes();
    Object.defineProperty(window.navigator, 'languages', { configurable: true, value: ['zh-CN', 'en-US'] });
    renderAt('/create');

    expect(screen.getByRole('heading', { name: '创建会议' })).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText('语言'), 'en');

    expect(screen.getByRole('heading', { name: 'Create a meeting' })).toBeVisible();
    expect(window.localStorage.getItem('babagan.locale')).toBe('en');
  });

  it('rejects a blank meeting name before sending a request', async () => {
    installBrowserFakes();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/create');

    await userEvent.click(screen.getByRole('button', { name: 'Create meeting' }));

    expect(screen.getByText('Meeting name is required.')).toBeVisible();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('displays and copies the meeting link after creation', async () => {
    installBrowserFakes();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/meetings/current')
      ? success({ meeting: null })
      : success({ slug, joinUrl: `https://meet.example/m/${slug}` }, 201)));
    renderAt('/create');

    await userEvent.type(screen.getByLabelText('Meeting name'), 'Design review');
    await userEvent.type(screen.getByLabelText('Admin password'), 'host-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Create meeting' }));

    expect(await screen.findByText(`https://meet.example/m/${slug}`)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Enter as host' })).toHaveAttribute('href', `https://meet.example/m/${slug}`);
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(`https://meet.example/m/${slug}`);
  });

  it('shows the API error without persisting the admin password', async () => {
    installBrowserFakes();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/meetings/current')
      ? success({ meeting: null })
      : success({
        error: { code: 'ADMIN_AUTH_FAILED', message: 'Authentication failed', correlationId: 'corr-123' }
      }, 401)));
    renderAt('/create');

    await userEvent.type(screen.getByLabelText('Meeting name'), 'Design review');
    await userEvent.type(screen.getByLabelText('Admin password'), 'host-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Create meeting' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Authentication failed');
    expect(window.localStorage.getItem('adminPassword')).toBeNull();
    expect(window.sessionStorage.getItem('adminPassword')).toBeNull();
  });

  it('shows the public current meeting and ends it with an in-memory admin password', async () => {
    installBrowserFakes();
    let ended = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meetings/current')) return success({
        meeting: ended ? null : {
          slug,
          name: 'Design review',
          status: 'active',
          joinUrl: `https://meet.example/meetings/${slug}`,
          requiresPassword: true,
          isFull: false
        }
      });
      if (url.endsWith(`/meetings/${slug}/admin-end`) && init?.method === 'POST') {
        ended = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/create');

    expect(await screen.findByRole('heading', { name: 'Current meeting' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Join current meeting' }))
      .toHaveAttribute('href', `https://meet.example/meetings/${slug}`);
    await userEvent.type(screen.getByLabelText('Admin password to end meeting'), 'admin-secret');
    await userEvent.click(screen.getByRole('button', { name: 'End current meeting' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Current meeting' })).not.toBeInTheDocument());
    expect(window.localStorage.getItem('adminPassword')).toBeNull();
    expect(window.sessionStorage.getItem('adminPassword')).toBeNull();
  });
});

describe('API client', () => {
  it('keeps JSON content type when a caller passes conflicting headers', async () => {
    installBrowserFakes();
    const fetchMock = vi.fn().mockResolvedValue(success({ slug, joinUrl: `https://meet.example/m/${slug}` }));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/meetings', CreateMeetingResponseSchema, {
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ adminPassword: 'admin-secret', name: 'Daily' })
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/meetings', expect.objectContaining({
      credentials: 'include', headers: { 'Content-Type': 'application/json' }
    }));
  });

  it('omits the JSON content type on bodyless requests', async () => {
    installBrowserFakes();
    const fetchMock = vi.fn().mockResolvedValue(success({
      participantIdentity: 'p-1', participantName: 'Ada', livekitUrl: 'wss://rtc.example', token: 'token',
      meetingExpiresAt: 1_725_000_000_000, permissions: { canPublishMicrophone: true, canShareScreen: false }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/meetings/slug-abcdefghijklmnopqrstuv/token', RefreshParticipantTokenResponseSchema, { method: 'POST' });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/meetings/slug-abcdefghijklmnopqrstuv/token', expect.objectContaining({
      credentials: 'include', method: 'POST', headers: {}
    }));
  });

  it('parses the standard API error envelope for no-content actions', async () => {
    installBrowserFakes();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({
      error: { code: 'ADMIN_AUTH_FAILED', message: 'Authentication failed', correlationId: 'corr-1' }
    }, 401)));

    await expect(apiNoContent('/meetings/current/admin-end', {
      method: 'POST', body: JSON.stringify({ adminPassword: 'wrong' })
    })).rejects.toMatchObject({
      status: 401,
      details: { error: { code: 'ADMIN_AUTH_FAILED' } }
    });
  });
});

describe('join lobby', () => {
  it('does not expose the join form before the meeting summary is validated', () => {
    installBrowserFakes();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    renderAt(`/m/${slug}`);

    expect(screen.queryByLabelText('Nickname')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join muted' })).not.toBeInTheDocument();
  });

  it.each(['ended', 'expired'] as const)('redirects a %s meeting summary to create', async (status) => {
    installBrowserFakes();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({
      name: 'Old meeting', status, requiresPassword: false, isFull: false
    })));
    renderAt(`/meetings/${slug}`);

    expect(await screen.findByRole('heading', { name: 'Create a meeting' })).toBeVisible();
    expect(screen.queryByLabelText('Nickname')).not.toBeInTheDocument();
  });

  it('marks and validates the password for a protected meeting', async () => {
    installBrowserFakes();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({
      name: 'Daily', status: 'created', requiresPassword: true, isFull: false
    })));
    renderAt(`/m/${slug}`);

    const password = await screen.findByLabelText('Meeting password');
    expect(password).toBeRequired();
    await userEvent.type(screen.getByLabelText('Nickname'), 'Ada');
    await userEvent.click(screen.getByRole('button', { name: 'Join muted' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Meeting password is required.');
  });

  it('keeps the password optional for an unprotected meeting', async () => {
    installBrowserFakes();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({
      name: 'Daily', status: 'created', requiresPassword: false, isFull: false
    })));
    renderAt(`/m/${slug}`);

    expect(await screen.findByLabelText('Meeting password')).not.toBeRequired();
    expect(screen.getByText('optional')).toBeVisible();
  });

  it('blocks unsupported desktop browsers with guidance', () => {
    installBrowserFakes({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1 Safari/17.0' });
    renderAt(`/m/${slug}`);

    expect(screen.getByRole('alert')).toHaveTextContent('Windows 10 or 11 with Chrome or Edge');
    expect(screen.getByRole('button', { name: 'Join muted' })).toBeDisabled();
  });

  it('shows mobile users the view and voice limitation notice', () => {
    installBrowserFakes({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1 Mobile/15E148' });
    renderAt(`/m/${slug}`);

    expect(screen.getByText('Mobile is available for view and voice only; screen sharing is not supported.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Join muted' })).toBeEnabled();
  });

  it('warns when the page is not running over HTTPS', () => {
    installBrowserFakes({ secure: false });
    renderAt(`/m/${slug}`);

    expect(screen.getByRole('alert')).toHaveTextContent('secure HTTPS connection');
    expect(screen.getByRole('button', { name: 'Join muted' })).toBeDisabled();
  });

  it('warns when WebRTC is unavailable', () => {
    installBrowserFakes({ webRtc: false });
    renderAt(`/m/${slug}`);

    expect(screen.getByRole('alert')).toHaveTextContent('WebRTC is unavailable');
  });

  it('blocks Chromium derivatives that are not Chrome or Edge', () => {
    installBrowserFakes({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0' });
    renderAt(`/m/${slug}`);

    expect(screen.getByRole('alert')).toHaveTextContent('Windows 10 or 11 with Chrome or Edge');
  });

  it('blocks Brave despite its Chrome user agent token', () => {
    installBrowserFakes();
    Object.defineProperty(window.navigator, 'brave', { configurable: true, value: {} });
    renderAt(`/m/${slug}`);

    expect(screen.getByRole('alert')).toHaveTextContent('Windows 10 or 11 with Chrome or Edge');
  });

  it('does not request microphone permission until a person starts the device check', async () => {
    const { getUserMedia, track } = installBrowserFakes();
    const rendered = renderAt(`/m/${slug}`);

    expect(getUserMedia).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Check microphone' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ audio: true }));
    rendered.unmount();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it('reports denied microphone permission', async () => {
    installBrowserFakes({ getUserMedia: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
    renderAt(`/m/${slug}`);

    await userEvent.click(screen.getByRole('button', { name: 'Check microphone' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone permission was denied');
  });

  it('explains when browser policy does not expose microphone access', async () => {
    installBrowserFakes();
    Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: undefined });
    renderAt(`/m/${slug}`);

    await userEvent.click(screen.getByRole('button', { name: 'Check microphone' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('does not expose microphone access');
  });

  it('stops a microphone stream that resolves after the lobby unmounts', async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const lateTrack = { stop: vi.fn() };
    const lateStream = { getTracks: () => [lateTrack] } as unknown as MediaStream;
    installBrowserFakes({ getUserMedia: () => new Promise<MediaStream>((resolve) => { resolveStream = resolve; }) });
    const rendered = renderAt(`/m/${slug}`);

    await userEvent.click(screen.getByRole('button', { name: 'Check microphone' }));
    rendered.unmount();
    resolveStream(lateStream);

    await waitFor(() => expect(lateTrack.stop).toHaveBeenCalledOnce());
  });

  it('stops an older microphone request when a newer check wins', async () => {
    let resolveFirst!: (stream: MediaStream) => void;
    const firstTrack = { stop: vi.fn() };
    const secondTrack = { stop: vi.fn() };
    const firstStream = { getTracks: () => [firstTrack] } as unknown as MediaStream;
    const secondStream = { getTracks: () => [secondTrack] } as unknown as MediaStream;
    const getUserMedia = vi.fn()
      .mockImplementationOnce(() => new Promise<MediaStream>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(secondStream);
    installBrowserFakes({ getUserMedia });
    renderAt(`/m/${slug}`);

    await userEvent.click(screen.getByRole('button', { name: 'Check microphone' }));
    await userEvent.click(screen.getByRole('button', { name: 'Check microphone' }));
    resolveFirst(firstStream);

    await waitFor(() => expect(firstTrack.stop).toHaveBeenCalledOnce());
    expect(secondTrack.stop).not.toHaveBeenCalled();
  });

  it('requires a nickname and sends a muted join request', async () => {
    installBrowserFakes();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/join')
      ? success({
        participantIdentity: 'p-1', participantName: 'Ada', livekitUrl: 'wss://rtc.example', token: 'token',
        meetingExpiresAt: 1_725_000_000_000, permissions: { publishSources: ['microphone'] }
      })
      : success({ name: 'Daily', status: 'created', requiresPassword: false, isFull: false }));
    vi.stubGlobal('fetch', fetchMock);
    renderAt(`/m/${slug}`);

    await userEvent.click(screen.getByRole('button', { name: 'Join muted' }));
    expect(screen.getByText('Nickname is required.')).toBeVisible();
    await userEvent.type(screen.getByLabelText('Nickname'), 'Ada');
    await userEvent.click(screen.getByRole('button', { name: 'Join muted' }));

    expect(await screen.findByRole('heading', { name: 'Ada, you are in' })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/meetings/${slug}/join`, expect.objectContaining({
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      body: JSON.stringify({ nickname: 'Ada' })
    }));
  });

  it('stops an active preview before joining', async () => {
    const { track } = installBrowserFakes();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({
      participantIdentity: 'p-1', participantName: 'Ada', livekitUrl: 'wss://rtc.example', token: 'token',
      meetingExpiresAt: 1_725_000_000_000, permissions: { publishSources: ['microphone'] }
    })));
    renderAt(`/m/${slug}`);

    await userEvent.click(screen.getByRole('button', { name: 'Check microphone' }));
    await userEvent.type(screen.getByLabelText('Nickname'), 'Ada');
    await userEvent.click(screen.getByRole('button', { name: 'Join muted' }));

    await waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
  });
});
