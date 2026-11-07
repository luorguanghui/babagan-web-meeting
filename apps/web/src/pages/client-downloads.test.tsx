import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../i18n/i18n.js';
import { ClientDownloads } from './client-downloads.js';

const windows = { available: true, version: '0.1.2', url: '/downloads/clients/windows/0.1.2/BabaganClientSetup-0.1.2.exe', bytes: 12345, sha256: 'a'.repeat(64) };
const android = { available: true, version: '0.1.2', url: '/downloads/clients/android/0.1.2/Babagan.apk', bytes: 54321, sha256: 'b'.repeat(64) };
function setup(userAgent: string, narrow: boolean) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  const media = Object.assign(new EventTarget(), { matches: narrow, media: '(max-width: 767px)' });
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schema: 1, releases: { windows, android } })));
  render(<LanguageProvider initialLocale="en"><ClientDownloads /></LanguageProvider>);
  return (matches: boolean) => act(() => { media.matches = matches; media.dispatchEvent(new Event('change')); });
}
const order = () => screen.getAllByRole('link').map(link => link.textContent);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('prioritizes Android on a real Android user agent even at a desktop width', async () => {
  const resize = setup('Mozilla/5.0 (Linux; Android 15; Tablet) AppleWebKit/537.36', false);
  await screen.findByRole('link', { name: 'Download for Android' });
  expect(order()).toEqual(['Download for Android', 'Download for Windows']);
  resize(true); resize(false);
  expect(order()).toEqual(['Download for Android', 'Download for Windows']);
  expect(screen.getByRole('link', { name: 'Download for Windows' })).toBeVisible();
});

it('updates the actual DOM and keyboard-link order when a non-Android viewport crosses the phone breakpoint', async () => {
  const resize = setup('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', false);
  await screen.findByRole('link', { name: 'Download for Windows' });
  expect(order()).toEqual(['Download for Windows', 'Download for Android']);
  resize(true);
  expect(order()).toEqual(['Download for Android', 'Download for Windows']);
  expect(screen.getAllByRole('article').map(article => article.getAttribute('aria-labelledby'))).toEqual(['client-android-title', 'client-windows-title']);
  resize(false);
  expect(order()).toEqual(['Download for Windows', 'Download for Android']);
});

it('starts with Android first for a narrow non-Android phone while keeping both choices', async () => {
  setup('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', true);
  await screen.findByRole('link', { name: 'Download for Android' });
  expect(order()).toEqual(['Download for Android', 'Download for Windows']);
});
