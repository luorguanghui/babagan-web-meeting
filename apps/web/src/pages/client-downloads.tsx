import { Download, Monitor, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useI18n } from '../i18n/i18n.js';
import { homeCopy } from './home-copy.js';

type Platform = 'windows' | 'android';
interface ClientRelease { available: true; version: string; url: string; bytes: number; sha256: string; }
type Catalog = Record<Platform, ClientRelease | undefined>;

function readRelease(value: unknown, platform: Platform): ClientRelease | undefined {
  if (!value || typeof value !== 'object') return;
  const release = value as Record<string, unknown>;
  if (release.available !== true) return;
  if (typeof release.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(release.version)
    || typeof release.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(release.sha256)
    || typeof release.bytes !== 'number' || !Number.isSafeInteger(release.bytes) || release.bytes <= 0 || release.bytes > 600_000_000) return;
  const name = platform === 'windows' ? `BabaganClientSetup-${release.version}.exe` : 'Babagan.apk';
  if (release.url !== `/downloads/clients/${platform}/${release.version}/${name}`) return;
  return release as unknown as ClientRelease;
}

export function readClientCatalog(value: unknown): Catalog {
  if (!value || typeof value !== 'object') throw new Error('Invalid client catalog');
  const catalog = value as { schema?: unknown; releases?: unknown };
  if (catalog.schema !== 1 || !catalog.releases || typeof catalog.releases !== 'object') throw new Error('Invalid client catalog');
  const releases = catalog.releases as Record<string, unknown>;
  return { windows: readRelease(releases.windows, 'windows'), android: readRelease(releases.android, 'android') };
}

export function ClientDownloads() {
  const { locale } = useI18n();
  const copy = homeCopy[locale];
  const [catalog, setCatalog] = useState<Catalog>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/downloads/clients/catalog.json', { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Client catalog unavailable');
        const result = readClientCatalog(await response.json());
        if (!controller.signal.aborted) setCatalog(result);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt]);

  return <div className="client-downloads">
    {(['windows', 'android'] as const).map(platform => {
      const release = catalog?.[platform];
      const Icon = platform === 'windows' ? Monitor : Smartphone;
      const action = platform === 'windows' ? copy.downloadWindows : copy.downloadAndroid;
      return <article className="client-release" key={platform} aria-labelledby={`client-${platform}-title`}>
        <div className="client-platform-icon"><Icon size={24} aria-hidden="true" /></div>
        <div className="client-release-content">
          <h3 id={`client-${platform}-title`}>{copy[platform]}</h3>
          <p>{platform === 'windows' ? copy.windowsDetail : copy.androidDetail}</p>
          {release && <p className="client-release-meta">v{release.version} · {(release.bytes / 1024 / 1024).toFixed(1)} {copy.bytes}</p>}
        </div>
        {release ? <a className="client-download-action" href={release.url} download><Download size={16} aria-hidden="true" />{action}</a>
          : <span className="client-release-status">{failed ? copy.unavailableNow : !catalog ? copy.loading : copy.unavailable}</span>}
        {release && <details className="client-checksum"><summary>{copy.checksum}</summary><code>{release.sha256}</code></details>}
      </article>;
    })}
    <div className="client-catalog-status" role="status">
      {failed && <p>{copy.failed} <button className="text-button" type="button" onClick={() => { setFailed(false); setCatalog(undefined); setAttempt(value => value + 1); }}>{copy.retry}</button></p>}
    </div>
  </div>;
}
