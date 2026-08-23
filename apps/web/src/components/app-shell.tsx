import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import { LanguageSelector } from './language-selector.js';

export function AppShell({ children }: { children: ReactNode }) {
  return <div className="app-root app-shell">
    <header className="app-bar">
      <a className="app-brand" href="/create" aria-label="Babagan home">
        <ShieldCheck aria-hidden="true" size={20} strokeWidth={2} />
        <span>Babagan</span>
      </a>
      <LanguageSelector />
    </header>
    {children}
  </div>;
}
