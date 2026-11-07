import { useEffect, useState } from 'react';
import { TaskPageLayout } from '../components/task-page-layout.js';
import { useI18n } from '../i18n/i18n.js';

interface NativeRelease { version: string; url: string; sha256: string; bytes: number }
function validRelease(value: unknown): value is NativeRelease {
  if (!value || typeof value !== 'object') return false;
  const release = value as NativeRelease;
  return typeof release.version === 'string' && /^\d+\.\d+\.\d+$/.test(release.version)
    && release.url === `/downloads/BabaganSetup-${release.version}.exe`
    && /^[a-f0-9]{64}$/.test(release.sha256) && Number.isSafeInteger(release.bytes) && release.bytes > 0;
}
export function NativeDownloadPage() {
  const { t } = useI18n();
  const [release, setRelease] = useState<NativeRelease>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void fetch('/downloads/native-release.json', { cache: 'no-store', signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('Download unavailable');
      const value: unknown = await response.json();
      if (!validRelease(value)) throw new Error('Invalid release');
      if (!abort.signal.aborted) setRelease(value);
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, []);
  return <TaskPageLayout eyebrow="BABAGAN · WINDOWS" title={t('native.downloadTitle')} lede={t('native.downloadLede')}
    context={<p>{t('native.receiverHint')}</p>}>
    <div className="native-download">
      <div className="native-download-heading"><img src="/brand/babagan-desktop.png" alt="" width="64" height="64" /><h2>{t('native.downloadHeading')}</h2></div>
      <p>{t('native.downloadRequirements')}</p>
      {release ? <>
        <a className="primary-button native-download-button" href={release.url} download>{t('native.downloadButton')}</a>
        <p className="native-download-meta">Windows x64 · v{release.version} · {(release.bytes / 1024 / 1024).toFixed(1)} MB</p>
        <p className="native-download-meta">{t('native.signingNotice')}</p>
      </> : <p role="status">{t(failed ? 'native.downloadUnavailable' : 'native.downloadLoading')}</p>}
      <ol className="native-download-steps">
        <li><strong>{t('native.installStep')}</strong><p>{t('native.installDetail')}</p></li>
        <li><strong>{t('native.launchStep')}</strong><p>{t('native.launchDetail')}</p></li>
        <li><strong>{t('native.shareStep')}</strong><p>{t('native.shareDetail')}</p></li>
      </ol>
      <p>{t('native.downloadFootnote')}</p>
      {release && <details><summary>{t('native.checksum')}</summary><code className="native-download-checksum">{release.sha256}</code></details>}
      <a href="/create">{t('native.backToMeeting')}</a>
    </div>
  </TaskPageLayout>;
}
