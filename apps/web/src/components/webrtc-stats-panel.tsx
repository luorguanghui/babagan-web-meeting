import type { ScreenShareCodec } from '@meeting/contracts';

import { useI18n } from '../i18n/i18n.js';
import type { WebRtcMediaStats, WebRtcStatsSnapshot } from '../meeting/webrtc-stats.js';

export function WebRtcStatsPanel({ snapshot, requestedCodec }: {
  snapshot?: WebRtcStatsSnapshot;
  requestedCodec: ScreenShareCodec;
}) {
  const { t } = useI18n();
  return <details className="webrtc-stats-panel">
    <summary>{t('stats.heading')}</summary>
    <p className="webrtc-stats-note">{t('stats.requestedCodec')}: {requestedCodec === 'auto' ? t('controls.codecAuto') : requestedCodec.toUpperCase()}</p>
    {!snapshot?.sender && !snapshot?.receiver
      ? <p>{t('stats.collecting')}</p>
      : <div className="webrtc-stats-grid">
        {snapshot.sender && <StatsSection title={t('stats.sender')} stats={snapshot.sender} />}
        {snapshot.receiver && <StatsSection title={t('stats.receiver')} stats={snapshot.receiver} />}
      </div>}
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
