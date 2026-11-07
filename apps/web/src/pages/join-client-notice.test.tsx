import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../i18n/i18n.js';
import { installBrowserFakes } from '../test/browser-fakes.js';

const client = vi.hoisted(() => ({ native: false }));
vi.mock('../client/client-host.js', () => ({ useClientHost: () => ({ host: client.native ? { platform: 'android' } : undefined }) }));
vi.mock('./meeting-room-page.js', () => ({ MeetingRoomPage: () => null }));
import { JoinLobbyPage } from './join-lobby-page.js';

beforeEach(() => {
  client.native = false;
  installBrowserFakes();
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/144.0.0.0 Mobile Safari/537.36' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'Test room', status: 'active', requiresPassword: true, isFull: false })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function show() { return render(<LanguageProvider initialLocale="zh-CN"><MemoryRouter><JoinLobbyPage slug="abcdefghijklmnopqrstuv" /></MemoryRouter></LanguageProvider>); }

it('does not apply mobile-browser sharing restrictions to the Android client', async () => {
  client.native = true;
  show(); await screen.findByLabelText('昵称');
  expect(screen.queryByText('移动设备仅支持观看和语音，不支持屏幕共享。')).not.toBeInTheDocument();
  expect(screen.getByLabelText(/会议密码/)).toBeRequired();
  expect(screen.getByRole('button', { name: '静音加入' })).toBeEnabled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('retains the restriction notice for an ordinary Android mobile browser', async () => {
  show(); await screen.findByLabelText('昵称');
  expect(screen.getByText('移动设备仅支持观看和语音，不支持屏幕共享。')).toBeVisible();
});

it('keeps the WebRTC availability check in the Android client', async () => {
  client.native = true;
  vi.stubGlobal('RTCPeerConnection', undefined);
  show(); await screen.findByLabelText('昵称');
  expect(screen.getByRole('alert')).toHaveTextContent('无法使用 WebRTC');
  expect(screen.getByRole('button', { name: '静音加入' })).toBeDisabled();
});
