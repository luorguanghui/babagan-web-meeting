import { ArrowLeft, Download, MonitorUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { LanguageSelector } from './language-selector.js';
import { useI18n } from '../i18n/i18n.js';
import { homeCopy } from '../pages/home-copy.js';
import { ClientUpdateStatus } from '../client/client-update-status.js';
import { useClientHost } from '../client/client-host.js';

export function AppShell({ children, showClientUpdate = true, backTo }: { children: ReactNode; showClientUpdate?: boolean; backTo?: string }) {
  const { locale } = useI18n();
  const copy = homeCopy[locale];
  const { host } = useClientHost();
  const workspaceLabel = locale === 'zh-CN' ? '工作台' : 'Workspace';
  const clientLabel = host?.platform === 'android' ? (locale === 'zh-CN' ? 'Android 客户端' : 'Android app')
    : (locale === 'zh-CN' ? 'Windows 客户端' : 'Windows app');
  const [avatarFailed, setAvatarFailed] = useState(false);
  return <div className={`app-root app-shell${host ? ' app-shell-client' : ''}`}>
    <header className="app-bar" data-task={Boolean(backTo) || undefined}>
      {backTo ? <Link className="app-back" to={backTo}>
        <ArrowLeft size={18} aria-hidden="true" />
        <span aria-hidden="true">{locale === 'zh-CN' ? '返回' : 'Back'}</span>
        <span className="sr-only">{locale === 'zh-CN' ? `返回 Babagan ${host ? '工作台' : '首页'}` : `Back to Babagan ${host ? 'workspace' : 'home'}`}</span>
      </Link>
        : <a className="app-brand" href={host ? '/client' : '/'} aria-label={host ? `Babagan ${workspaceLabel}` : copy.home}>
        {!avatarFailed && <img className="app-brand-avatar" src="/theme/sigrika-avatar.png" alt="" width="36" height="36" onError={() => setAvatarFailed(true)} />}
        <span className="app-brand-wordmark">Babagan</span>
        {host && <span className="client-host-label">{clientLabel}</span>}
      </a>}
      <div className="app-bar-actions">
        {host ? (showClientUpdate && <ClientUpdateStatus />) : !backTo && <>
          <a className="app-bar-link" href="/#downloads" aria-label={copy.downloads}><Download size={17} aria-hidden="true" /><span className="app-download-wide">{copy.downloads}</span><span className="app-download-short">{copy.downloadShort}</span></a>
          <a className="app-bar-link app-component-link" href="/native"><MonitorUp size={17} aria-hidden="true" />{copy.componentNav}</a>
        </>}
        <LanguageSelector compact />
      </div>
    </header>
    {children}
  </div>;
}
