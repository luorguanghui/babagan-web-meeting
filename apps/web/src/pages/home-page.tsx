import { ArrowDown, ArrowUpRight, AudioLines, MonitorUp } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '../i18n/i18n.js';
import { ClientDownloads } from './client-downloads.js';
import { homeCopy } from './home-copy.js';
import './home-page.css';

export function HomePage() {
  const { locale } = useI18n();
  const copy = homeCopy[locale];
  const [artFailed, setArtFailed] = useState(false);
  return <>
    <main className="home-page" lang={locale}>
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-copy">
          <h1 id="home-title">{copy.titleLines.map(line => <span key={line}>{line}</span>)}</h1>
          <p>{copy.intro}</p>
          <div className="home-hero-actions">
            <a className="home-primary-action" href="/create">{copy.web}<ArrowUpRight size={19} aria-hidden="true" /></a>
            <a className="home-secondary-action" href="#downloads">{copy.downloads}<ArrowDown size={17} aria-hidden="true" /></a>
          </div>
        </div>
        <div className={`home-hero-art${artFailed ? ' home-hero-art-fallback' : ''}`}>
          <div className="home-hello"><AudioLines size={24} strokeWidth={2} aria-hidden="true" /><span>{copy.hello}</span></div>
          {artFailed ? <span className="home-art-wordmark" aria-hidden="true">Babagan</span> : <img src="/theme/sigrika-hero.png" alt={copy.heroAlt} width="960" height="960" fetchPriority="high" onError={() => setArtFailed(true)} />}
        </div>
      </section>
      <section className="home-options" id="downloads" aria-labelledby="home-options-title">
        <div className="home-download-layout">
          <div className="home-section-heading"><h2 id="home-options-title">{copy.choiceTitle}</h2><p>{copy.choiceIntro}</p></div>
          <section className="home-client-option" aria-labelledby="home-clients-title">
            <h3 id="home-clients-title">{copy.clientsTitle}</h3>
            <p>{copy.clientsIntro}</p>
            <ClientDownloads />
          </section>
        </div>
        <article className="home-component-option">
          <div className="home-component-symbol"><MonitorUp size={38} strokeWidth={1.6} aria-hidden="true" /></div>
          <div className="home-component-copy"><h3>{copy.componentTitle}</h3><p>{copy.componentBody}</p></div>
          <div className="home-component-end"><a className="home-component-action" href="/native">{copy.componentAction}<ArrowUpRight size={18} aria-hidden="true" /></a><p className="home-component-note">{copy.componentNote}</p></div>
        </article>
      </section>
    </main>
    <footer className="home-footer"><span>Babagan</span><p>{copy.footer}</p><small>{copy.fanTheme}</small></footer>
  </>;
}
