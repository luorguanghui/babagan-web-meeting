import { RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n/i18n.js';
import { checkClientUpdate, useClientHost } from './client-host.js';
import { ClientUpdateProgress } from './client-update-progress.js';
import './client-status.css';

export function ClientUpdateStatus() {
  const client = useClientHost();
  const { t } = useI18n();
  if (!client.host) return null;
  const status = client.joined && ['available', 'ready', 'downloading'].includes(client.update) ? t('client.update.deferred')
    : client.host.platform === 'android' && client.update === 'ready' ? t('client.update.readyAndroid')
    : client.updateProgress?.phase === 'verifying' ? t('client.update.verifying') : t(`client.update.${client.update}`);
  return <div className="client-update-status">
    <span role="status">{status}{client.info && <span className="client-version"> v{client.info.appVersion}</span>}</span>
    <ClientUpdateProgress compact />
    <button type="button" className="client-update-check" title={client.joined ? t('client.update.deferred') : status} aria-label={t('client.update.check')} aria-busy={client.update === 'checking'}
      disabled={client.joined || client.update === 'checking' || client.update === 'downloading' || client.update === 'installing'} onClick={() => void checkClientUpdate()}><RefreshCw size={15} aria-hidden="true" /></button>
  </div>;
}
