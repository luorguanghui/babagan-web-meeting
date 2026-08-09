import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { LanguageProvider, resolveInitialLocale, useI18n } from './i18n.js';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.lang = '';
});

function Probe() {
  const { locale, setLocale, t } = useI18n();
  return <>
    <p>{locale}</p>
    <p>{t('create.heading')}</p>
    <button type="button" onClick={() => setLocale('zh-CN')}>中文</button>
  </>;
}

describe('language selection', () => {
  it('follows a Chinese browser language unless a saved choice overrides it', () => {
    expect(resolveInitialLocale(undefined, ['zh-HK', 'en-US'])).toBe('zh-CN');
    expect(resolveInitialLocale('en', ['zh-CN'])).toBe('en');
    expect(resolveInitialLocale('invalid', ['fr-FR'])).toBe('en');
  });

  it('updates the page language and persists a manual choice', async () => {
    render(<LanguageProvider initialLocale="en"><Probe /></LanguageProvider>);

    await userEvent.click(screen.getByRole('button', { name: '中文' }));

    expect(screen.getByText('创建会议')).toBeVisible();
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(window.localStorage.getItem('babagan.locale')).toBe('zh-CN');
  });
});
