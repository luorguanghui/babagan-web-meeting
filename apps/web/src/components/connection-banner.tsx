import { useI18n } from '../i18n/i18n.js';
import type { ReconnectState } from '../meeting/reconnect-controller.js';

export function ConnectionBanner({ state, online, rateLimited = false }: { state: ReconnectState; online: boolean; rateLimited?: boolean }) {
  const { t } = useI18n();
  const message = !online
    ? t('connection.offline')
    : state.kind === 'connected'
      ? t('connection.connected')
      : state.kind === 'refreshing-token'
        ? t('connection.refreshing')
        : state.kind === 'reconnecting'
          ? rateLimited ? t('connection.busy') : t('connection.reconnecting')
          : state.kind === 'rejoin-required'
            ? t('connection.rejoin')
            : t('connection.ended');
  return <p className={`connection-banner connection-${state.kind}`} role="status" aria-live="polite">
    <span aria-hidden="true">{state.kind === 'connected' && online ? '●' : '!'}</span> {message}
  </p>;
}
