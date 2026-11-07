import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../i18n/i18n.js';

const state = vi.hoisted(() => ({ value: { host: { platform: 'android' }, joined: false, update: 'downloading', updateProgress: undefined } as Record<string, unknown> }));
vi.mock('./client-host.js', () => ({ useClientHost: () => state.value, checkClientUpdate: () => Promise.resolve() }));
import { ClientUpdateStatus } from './client-update-status.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => { for (const root of roots.splice(0)) root.unmount(); }); document.body.innerHTML = ''; });
function render(progress: unknown, update = 'downloading', joined = false) {
  state.value = { host: { platform: 'android' }, update, joined, updateProgress: progress };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  act(() => root.render(<LanguageProvider initialLocale="en"><ClientUpdateStatus /></LanguageProvider>));
  return container;
}

it('shows downloaded bytes and the signed total in an accessible native progress bar', () => {
  const container = render({ phase: 'downloading', downloadedBytes: 25_000_000, totalBytes: 100_000_000 });
  const bar = container.querySelector('progress');
  expect(bar).not.toBeNull();
  expect(bar?.value).toBe(25_000_000); expect(bar?.max).toBe(100_000_000);
  expect(container.textContent).toContain('25%');
  expect(container.textContent).toContain('25.0 / 100.0 MB');
  expect(bar?.getAttribute('aria-label')).toBeTruthy();
});

it.each(['verifying', 'installing'])('keeps %s indeterminate without claiming completion', phase => {
  const container = render({ phase, downloadedBytes: 100, totalBytes: 100 }, phase === 'installing' ? 'installing' : 'downloading');
  expect(container.querySelector('progress')).not.toBeNull();
  expect(container.querySelector('progress')?.hasAttribute('value')).toBe(false);
  expect(container.textContent).not.toContain('100%');
});

it('shows indeterminate progress for an older host without byte counts', () => {
  const container = render(undefined);
  expect(container.querySelector('progress')).not.toBeNull();
  expect(container.querySelector('progress')?.hasAttribute('value')).toBe(false);
  expect(container.textContent).not.toContain('%');
});

it.each(['deferred', 'error', 'ready'])('removes the active progress bar for %s', update => {
  expect(render(undefined, update).querySelector('progress')).toBeNull();
});

it('hides active download progress when a meeting begins', () => {
  expect(render({ phase: 'downloading', downloadedBytes: 25, totalBytes: 100 }, 'downloading', true).querySelector('progress')).toBeNull();
});
