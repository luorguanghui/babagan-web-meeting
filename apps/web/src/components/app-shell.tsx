import { useState, type ReactNode } from 'react';

import { LanguageSelector } from './language-selector.js';
import { useI18n } from '../i18n/i18n.js';
import { homeCopy } from '../pages/home-copy.js';
import { ClientUpdateStatus } from '../client/client-update-status.js';

export function AppShell({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const copy = homeCopy[locale];
  const [avatarFailed, setAvatarFailed] = useState(false);
  return <div className="app-root app-shell">
    <header className="app-bar">
      <a className="app-brand" href="/" aria-label={copy.home}>
        {!avatarFailed && <img className="app-brand-avatar" src="/theme/sigrika-avatar.png" alt="" width="42" height="42" onError={() => setAvatarFailed(true)} />}
        <span className="app-brand-wordmark">Babagan</span>
      </a>
      <div className="app-bar-actions"><ClientUpdateStatus /><a className="app-component-link" href="/native">{copy.componentNav}</a><a href="/#downloads">{copy.downloads}</a><LanguageSelector /></div>
    </header>
    {children}
  </div>;
}
