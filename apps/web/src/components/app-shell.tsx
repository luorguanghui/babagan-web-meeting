import type { ReactNode } from 'react';

import { LanguageSelector } from './language-selector.js';

export function AppShell({ children }: { children: ReactNode }) {
  return <div className="app-root app-shell">
    <header className="app-bar">
      <a className="app-brand" href="/create" aria-label="Babagan home">
        <img src="/brand/babagan-wordmark.svg" alt="Babagan" width="138" height="35" />
        <span className="sr-only">Babagan</span>
      </a>
      <LanguageSelector />
    </header>
    {children}
  </div>;
}
