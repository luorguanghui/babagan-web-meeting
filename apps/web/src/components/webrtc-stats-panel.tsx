import type { P2pTurnProvider, ScreenShareCodec } from '@meeting/contracts';

import { type MessageKey, useI18n } from '../i18n/i18n.js';
import type { ScreenTransportMode, ScreenTurnProvider } from '../meeting/screen-transport-mode.js';
import type { WebRtcMediaStats, WebRtcStatsSnapshot } from '../meeting/webrtc-stats.js';

const modeKeys: Record<ScreenTransportMode, MessageKey> = {
  p2p: 'screenTransport.p2p',
  turn: 'screenTransport.turn',
  sfu: 'screenTransport.sfu',
  mixed: 'screenTransport.mixed',
  negotiating: 'screenTransport.negotiating',
  waiting: 'screenTransport.waiting'
};
const turnProviderKeys: Record<ScreenTurnProvider, MessageKey> = {
  cloudflare: 'screenTransport.turnCloudflare',
  coturn: 'screenTransport.turnCoturn',
  mixed: 'screenTransport.turnMixed'
};

export function WebRtcStatsPanel({ snapshot, requestedCodec, mode = 'sfu', turnProvider, embedded = false, active = true }: {
  snapshot?: WebRtcStatsSnapshot;
  requestedCodec: ScreenShareCodec;
  mode?: ScreenTransportMode;
  turnProvider?: P2pTurnProvider | 'mixed';
  embedded?: boolean;
  active?: boolean;
}) {
  const { t } = useI18n();
  const transportKey = mode === 'turn' && turnProvider !== undefined
    ? turnProviderKeys[turnProvider]
    : modeKeys[mode];
  const heading = <>
      <span>{t('stats.heading')}</span>
      <span className="webrtc-transport-badge" data-mode={mode} aria-live="polite">{t(transportKey)}</span>
    </>;
  const content = <>
    <p className="webrtc-stats-note">{t('stats.requestedCodec')}: {requestedCodec === 'auto' ? t('controls.codecAuto') : requestedCodec.toUpperCase()}</p>
    {!snapshot?.sender && !snapshot?.receiver
      ? <p>{t(active ? 'stats.collecting' : 'stats.noData')}</p>
      : <div className="webrtc-stats-grid">
        {snapshot.sender && <StatsSection title={t('stats.sender')} stats={snapshot.sender} />}
        {snapshot.receiver && <StatsSection title={t('stats.receiver')} stats={snapshot.receiver} />}
      </div>}
  </>;
  if (embedded) return <section className="webrtc-stats-panel webrtc-stats-panel-embedded">
    <h3 className="webrtc-stats-heading">{heading}</h3>
    {content}
  </section>;
  return <details className="webrtc-stats-panel">
    <summary>{heading}</summary>
    {content}
  </details>;
}

function StatsSection({ title, stats }: { title: string; stats: WebRtcMediaStats }) {
  const { t } = useI18n();
  const rows: Array<[string, string | undefined]> = [
    [t('stats.codec'), stats.codec],
    [t('stats.resolution'), stats.width && stats.height ? `${stats.width}×${stats.height}` : undefined],
    [t('stats.fps'), format(stats.framesPerSecond)],
    [t('stats.bitrate'), unit(stats.bitrateMbps, 'Mbps')],
    [t('stats.packetLoss'), format(stats.packetsLost)],
    [t('stats.rtt'), unit(stats.roundTripTimeMs, 'ms')],
    [t('stats.droppedFrames'), format(stats.framesDropped)],
    [t('stats.freezes'), format(stats.freezeCount)],
    [t('stats.encodeTime'), unit(stats.averageEncodeTimeMs, 'ms')],
    [t('stats.jitter'), unit(stats.jitterMs, 'ms')],
    [t('stats.jitterBuffer'), unit(stats.averageJitterBufferDelayMs, 'ms')],
    [t('stats.bandwidth'), unit(stats.availableOutgoingBitrateMbps, 'Mbps')],
    [t('stats.limitation'), stats.qualityLimitationReason],
    ['NACK / PLI / FIR', `${stats.nackCount ?? 0} / ${stats.pliCount ?? 0} / ${stats.firCount ?? 0}`]
  ];
  return <section>
    <h3>{title}</h3>
    <dl>{rows.filter(([, value]) => value !== undefined).map(([label, value]) => <div key={label}>
      <dt>{label}</dt><dd>{value}</dd>
    </div>)}</dl>
  </section>;
}

function format(value?: number): string | undefined {
  return value === undefined ? undefined : String(value);
}

function unit(value: number | undefined, suffix: string): string | undefined {
  return value === undefined ? undefined : `${value} ${suffix}`;
}
