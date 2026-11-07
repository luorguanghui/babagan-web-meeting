import { useI18n } from '../i18n/i18n.js';
import { useClientHost } from './client-host.js';
import './client-status.css';

/** Byte counts come only from the native updater's signed artifact download. */
export function ClientUpdateProgress({ compact = false }: { compact?: boolean }) {
  const client = useClientHost();
  const { t, locale } = useI18n();
  if (!client.host || client.joined || !['downloading', 'installing'].includes(client.update)) return null;
  const progress = client.updateProgress;
  const phase = progress?.phase ?? (client.update === 'installing' ? 'installing' : 'downloading');
  const determinate = phase === 'downloading' && progress !== undefined && progress.downloadedBytes < progress.totalBytes;
  const number = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const detail = determinate
    ? `${Math.floor(progress.downloadedBytes / progress.totalBytes * 100)}% · ${number.format(progress.downloadedBytes / 1_000_000)} / ${number.format(progress.totalBytes / 1_000_000)} MB`
    : undefined;
  const completedTransfer = progress && progress.downloadedBytes === progress.totalBytes;
  const label = t(`client.update.${phase === 'downloading' && completedTransfer ? 'verifying' : phase}`);
  return <div className={`client-update-progress${compact ? ' client-update-progress-compact' : ''}`}>
    <div className="client-update-progress-label"><span role="status">{label}</span>{detail && <span className="client-update-progress-bytes">{detail}</span>}</div>
    <progress aria-label={t('client.update.progress')} aria-valuetext={detail ? `${label} ${detail}` : label}
      max={determinate ? progress.totalBytes : undefined} value={determinate ? progress.downloadedBytes : undefined} />
  </div>;
}
