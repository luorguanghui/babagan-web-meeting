import { ChevronRight, MonitorUp } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useI18n } from '../i18n/i18n.js';
import { ClientDownloads } from './client-downloads.js';
import { homeCopy } from './home-copy.js';
import { MeetingEntryForm } from './meeting-entry-form.js';
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
          <div className="home-entry">
            <MeetingEntryForm />
            <Link className="home-start-action" to="/create">{copy.web}<ChevronRight size={18} aria-hidden="true" /></Link>
          </div>
        </div>
        <div className="home-hero-art">
          <span className="home-art-light" aria-hidden="true" />
          {artFailed ? <span className="home-art-wordmark" aria-hidden="true">Babagan</span> : <img src="/theme/sigrika-hero.png" alt={copy.heroAlt} width="1186" height="1326" fetchPriority="high" onError={() => setArtFailed(true)} />}
        </div>
      </section>
      <section className="home-options" id="downloads" aria-labelledby="home-options-title">
        <h2 id="home-options-title">{copy.clientsTitle}</h2>
        <ClientDownloads extra={<article className="client-release" aria-labelledby="home-native-title">
          <div className="client-platform-icon"><MonitorUp size={22} aria-hidden="true" /></div>
          <div className="client-release-content"><h3 id="home-native-title">{copy.componentType}</h3><p>{copy.componentBody}</p></div>
          <Link className="client-download-action" aria-label={copy.componentAction} to="/native"><span className="client-download-label">{copy.componentAction}</span><ChevronRight size={18} aria-hidden="true" /></Link>
        </article>} />
      </section>
    </main>
    <footer className="home-footer"><span>Babagan</span><small>{copy.fanTheme}</small></footer>
  </>;
}
