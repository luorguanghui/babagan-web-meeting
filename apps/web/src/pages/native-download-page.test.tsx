import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeDownloadPage } from './native-download-page.js';
import { LanguageProvider } from '../i18n/i18n.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('offers the verified same-origin installer and makes receiver requirements clear', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: '0.2.0', url: '/downloads/BabaganSetup-0.2.0.exe', bytes: 100000, sha256: 'a'.repeat(64) })));
  render(<LanguageProvider><NativeDownloadPage /></LanguageProvider>);
  expect(await screen.findByRole('link', { name: 'Download Windows installer' })).toHaveAttribute('href', '/downloads/BabaganSetup-0.2.0.exe');
  expect(screen.getByText(/Viewers need nothing to install/)).toBeVisible();
  expect(screen.getByText(/default per-viewer cap is 10 Mbps/)).toBeVisible();
});
it('does not offer a download when release metadata points off-site or is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: '0.2.0', url: 'https://example.test/setup.exe', bytes: 100000, sha256: 'a'.repeat(64) })));
  render(<LanguageProvider><NativeDownloadPage /></LanguageProvider>);
  expect(await screen.findByText(/installer is not available yet/)).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Download Windows installer' })).not.toBeInTheDocument();
});
