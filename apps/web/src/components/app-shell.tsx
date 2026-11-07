import { useState, type ReactNode } from 'react';

import { LanguageSelector } from './language-selector.js';
import { useI18n } from '../i18n/i18n.js';
import { homeCopy } from '../pages/home-copy.js';
import { ClientUpdateStatus } from '../client/client-update-status.js';
import { useClientHost } from '../client/client-host.js';

export function AppShell({ children, showClientUpdate = true }: { children: ReactNode; showClientUpdate?: boolean }) {
  const { locale } = useI18n();
  const copy = homeCopy[locale];
  const { host } = useClientHost();
  const workspaceLabel = locale === 'zh-CN' ? '工作台' : 'Workspace';
  const clientLabel = host?.platform === 'android' ? (locale === 'zh-CN' ? 'Android 客户端' : 'Android app')
    : (locale === 'zh-CN' ? 'Windows 客户端' : 'Windows app');
  const [avatarFailed, setAvatarFailed] = useState(false);
  return <div className={`app-root app-shell${host ? ' app-shell-client' : ''}`}>
    <header className="app-bar">
      <a className="app-brand" href={host ? '/client' : '/'} aria-label={host ? `Babagan ${workspaceLabel}` : copy.home}>
        {!avatarFailed && <img className="app-brand-avatar" src="/theme/sigrika-avatar.png" alt="" width="42" height="42" onError={() => setAvatarFailed(true)} />}
        <span className="app-brand-wordmark">Babagan</span>
        {host && <span className="client-host-label">{clientLabel}</span>}
      </a>
      <div className="app-bar-actions">
        {host ? <><a href="/client">{workspaceLabel}</a>{showClientUpdate && <ClientUpdateStatus />}</>
          : <><a className="app-component-link" href="/native">{copy.componentNav}</a><a href="/#downloads">{copy.downloads}</a></>}
        <LanguageSelector />
      </div>
    </header>
    {children}
  </div>;
}
