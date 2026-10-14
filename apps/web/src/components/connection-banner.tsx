import { useI18n } from '../i18n/i18n.js';
import type { ReconnectState } from '../meeting/reconnect-controller.js';
import type { MeetingConnectionState } from '../meeting/room-controller.js';

export function ConnectionBanner({ state, online, rateLimited = false, connection = 'connected' }: { state: ReconnectState; online: boolean; rateLimited?: boolean; connection?: MeetingConnectionState }) {
  const { t } = useI18n();
  const kind = state.kind === 'connected' ? connection : state.kind;
  const message = !online
    ? t('connection.offline')
    : kind === 'connected'
      ? t('connection.connected')
      : kind === 'connecting'
        ? t('connection.connecting')
        : kind === 'disconnected'
          ? t('connection.disconnected')
          : kind === 'refreshing-token'
            ? t('connection.refreshing')
            : kind === 'reconnecting'
              ? rateLimited ? t('connection.busy') : t('connection.reconnecting')
              : kind === 'rejoin-required'
                ? t('connection.rejoin')
                : t('connection.ended');
  return <p className={`connection-banner connection-${kind}`} role="status" aria-live="polite">
    <span aria-hidden="true">{kind === 'connected' && online ? '●' : '!'}</span> {message}
  </p>;
}
