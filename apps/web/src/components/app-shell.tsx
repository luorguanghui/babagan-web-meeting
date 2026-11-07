import type { ReactNode } from 'react';

import { LanguageSelector } from './language-selector.js';
import { useI18n } from '../i18n/i18n.js';

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return <div className="app-root app-shell">
    <header className="app-bar">
      <a className="app-brand" href="/create" aria-label="Babagan home">
        <img src="/brand/babagan-wordmark.svg" alt="Babagan" width="138" height="35" />
        <span className="sr-only">Babagan</span>
      </a>
      <div className="app-bar-actions"><a href="/native" target="_blank" rel="noopener noreferrer">{t('native.downloadNav')}</a><LanguageSelector /></div>
    </header>
    {children}
  </div>;
}
