import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import { LanguageProvider } from '../i18n/i18n.js';
import { readClientCatalog } from './client-downloads.js';
import { HomePage } from './home-page.js';

const windows = { available: true, version: '0.3.0', url: '/downloads/clients/windows/0.3.0/BabaganClientSetup-0.3.0.exe', bytes: 12_345_678, sha256: 'a'.repeat(64) };
const catalog = (release: unknown = windows) => ({ schema: 1, releases: { windows: release, android: { available: false } } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function LobbyDestination() { return <output aria-label="Lobby destination">{useLocation().pathname}</output>; }

function showHome(locale: 'en' | 'zh-CN' = 'en') {
  return render(<LanguageProvider initialLocale={locale}><MemoryRouter><Routes>
    <Route path="/" element={<HomePage />} />
    <Route path="/m/:slug" element={<LobbyDestination />} />
  </Routes></MemoryRouter></LanguageProvider>);
}

it('keeps web and sharing-component entry points while offering only a published full client', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(catalog())));
  showHome();
  expect(screen.getByRole('link', { name: 'Start a meeting' })).toHaveAttribute('href', '/create');
  expect(screen.getByRole('link', { name: 'Get sharing component' })).toHaveAttribute('href', '/native');
  expect(await screen.findByRole('link', { name: 'Download for Windows' })).toHaveAttribute('href', windows.url);
  expect(screen.queryByRole('link', { name: 'Download for Android' })).not.toBeInTheDocument();
  expect(screen.getByText('Not released yet')).toBeVisible();
});

it('opens the lobby from a homepage invitation, while keeping a foreign link on the homepage', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(catalog())));
  const slug = 'abcdefghijklmnopqrstuv';
  showHome();
  await screen.findByRole('link', { name: 'Download for Windows' });
  const input = screen.getByRole('textbox', { name: 'Meeting link or ID' });
  const submit = screen.getByRole('button', { name: 'Join meeting' });
  fireEvent.change(input, { target: { value: `https://example.test/m/${slug}` } });
  fireEvent.click(submit);
  expect(screen.getByRole('alert')).toHaveTextContent('this Babagan site');
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: `${window.location.origin}/m/${slug}` } });
  fireEvent.click(submit);
  expect(screen.getByLabelText('Lobby destination')).toHaveTextContent(`/m/${slug}`);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  'https://example.test/Babagan.exe', '//example.test/Babagan.exe',
  '/downloads/clients/../Babagan.exe', '/downloads/clients/%2e%2e/Babagan.exe',
  '/downloads/clients/Babagan.exe?redirect=elsewhere', '/downloads/clients/Babagan.apk',
])('never trusts an unsafe or mismatched Windows release URL: %s', url => {
  expect(readClientCatalog(catalog({ ...windows, url })).windows).toBeUndefined();
});

it('requires the current catalog schema and complete, valid artifact metadata', () => {
  expect(() => readClientCatalog({ schema: 2, releases: {} })).toThrow();
  expect(() => readClientCatalog({ schema: 1 })).toThrow();
  for (const release of [
    { ...windows, available: false }, { ...windows, sha256: 'invalid' },
    { ...windows, bytes: 0 }, { ...windows, bytes: 3.5 }, { ...windows, version: 'latest' },
  ]) expect(readClientCatalog(catalog(release)).windows).toBeUndefined();
});

it('shows a Chinese failure state without creating download links after a failed lookup', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
  showHome('zh-CN');
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('客户端下载暂不可用。'));
  expect(screen.queryByRole('link', { name: '下载 Windows 版' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '下载 Android 版' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重试' })).toBeVisible();
});
