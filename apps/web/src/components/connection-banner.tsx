import type { ReconnectState } from '../meeting/reconnect-controller.js';

export function ConnectionBanner({ state, online, rateLimited = false }: { state: ReconnectState; online: boolean; rateLimited?: boolean }) {
  const message = !online
    ? 'You are offline. Reconnecting when your connection returns.'
    : state.kind === 'connected'
      ? 'Connected'
      : state.kind === 'refreshing-token'
        ? 'Refreshing your secure meeting connection…'
        : state.kind === 'reconnecting'
          ? rateLimited ? 'The service is busy. Retrying your meeting connection shortly…' : 'Reconnecting to the meeting…'
          : state.kind === 'rejoin-required'
            ? 'Your connection could not be restored. Please rejoin the meeting.'
            : 'This meeting has ended or expired.';
  return <p className={`connection-banner connection-${state.kind}`} role="status" aria-live="polite">
    <span aria-hidden="true">{state.kind === 'connected' && online ? '●' : '!'}</span> {message}
  </p>;
}
