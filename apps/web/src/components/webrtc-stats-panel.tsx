import type { P2pTurnProvider, ScreenShareCodec } from '@meeting/contracts';

import { type MessageKey, useI18n } from '../i18n/i18n.js';
import type { P2pEncodingDiagnostics } from '../meeting/p2p-share-controller.js';
import type { TurnPathProbeSnapshot } from '../meeting/cloudflare-turn-capacity.js';
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

export function WebRtcStatsPanel({
  snapshot,
  requestedCodec,
  mode = 'sfu',
  turnProvider,
  turnProbe,
  encodingDiagnostics,
  embedded = false,
  active = true
}: {
  snapshot?: WebRtcStatsSnapshot;
  requestedCodec: ScreenShareCodec;
  mode?: ScreenTransportMode;
  turnProvider?: P2pTurnProvider | 'mixed';
  turnProbe?: TurnPathProbeSnapshot;
  encodingDiagnostics?: ReadonlyMap<string, P2pEncodingDiagnostics>;
  embedded?: boolean;
  active?: boolean;
}) {
  const { t } = useI18n();
  const transportKey = mode === 'turn' && turnProvider !== undefined
    ? turnProviderKeys[turnProvider]
    : modeKeys[mode];
  const hasMediaStats = Boolean(snapshot?.sender || snapshot?.receiver);
  const hasTurnProbe = (turnProvider === 'cloudflare' || turnProvider === 'mixed') && turnProbe !== undefined;
  const hasEncodingDiagnostics = (encodingDiagnostics?.size ?? 0) > 0;
  const heading = <>
      <span>{t('stats.heading')}</span>
      <span className="webrtc-transport-badge" data-mode={mode} aria-live="polite">{t(transportKey)}</span>
    </>;
  const content = <>
    <p className="webrtc-stats-note">{t('stats.requestedCodec')}: {requestedCodec === 'auto' ? t('controls.codecAuto') : requestedCodec.toUpperCase()}</p>
    {!hasMediaStats && !hasTurnProbe && !hasEncodingDiagnostics
      ? <p>{t(active ? 'stats.collecting' : 'stats.noData')}</p>
      : <div className="webrtc-stats-grid">
        {snapshot?.sender && <StatsSection title={t('stats.sender')} stats={snapshot.sender} sender />}
        {snapshot?.receiver && <StatsSection title={t('stats.receiver')} stats={snapshot.receiver} />}
        {(turnProvider === 'cloudflare' || turnProvider === 'mixed') && turnProbe
          && <TurnDiagnosticsSection snapshot={turnProbe} />}
        {encodingDiagnostics && encodingDiagnostics.size > 0 && <EncodingDiagnosticsSection diagnostics={encodingDiagnostics} />}
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

function StatsSection({ title, stats, sender = false }: { title: string; stats: WebRtcMediaStats; sender?: boolean }) {
  const { t } = useI18n();
  const rows: Array<[string, string | undefined]> = [
    [t('stats.codec'), stats.codec],
    [t('stats.resolution'), stats.width && stats.height ? `${stats.width}×${stats.height}` : undefined],
    [t('stats.fps'), format(stats.framesPerSecond)],
    [sender ? t('stats.actualOutgoing') : t('stats.bitrate'), unit(stats.bitrateMbps, 'Mbps')],
    [sender ? t('stats.encoderTarget') : t('stats.bitrate'), unit(stats.encoderTargetBitrateMbps, 'Mbps')],
    [t('stats.packetLoss'), format(stats.packetsLost)],
    [t('stats.rtt'), unit(stats.roundTripTimeMs, 'ms')],
    [t('stats.droppedFrames'), format(stats.framesDropped)],
    [t('stats.freezes'), format(stats.freezeCount)],
    [t('stats.encodeTime'), unit(stats.averageEncodeTimeMs, 'ms')],
    [t('stats.jitter'), unit(stats.jitterMs, 'ms')],
    [t('stats.jitterBuffer'), unit(stats.averageJitterBufferDelayMs, 'ms')],
    [sender ? t('stats.rtcEstimate') : t('stats.bandwidth'), unit(stats.availableOutgoingBitrateMbps, 'Mbps')],
    [t('stats.selectedCandidate'), stats.selectedCandidateType],
    [t('stats.selectedCandidateUrl'), stats.selectedCandidateUrl],
    [t('stats.relayProtocol'), stats.relayProtocol],
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

function TurnDiagnosticsSection({ snapshot }: { snapshot: TurnPathProbeSnapshot }) {
  const { t } = useI18n();
  const capacity = snapshot.stableCapacityBps;
  const rows: Array<[string, string | undefined]> = [
    [t('stats.turnProbeStatus'), snapshot.status],
    [t('stats.turnProbeCapacity'), bitrate(capacity)],
    [t('stats.turnProbeSampledAt'), snapshot.sampledAt === undefined ? undefined : formatTimestamp(snapshot.sampledAt)],
    [t('stats.relayProtocol'), snapshot.selectedProtocol]
  ];
  return <section className="webrtc-stats-detail">
    <h3>{t('stats.turnDiagnostics')}</h3>
    <dl>{rows.filter(([, value]) => value !== undefined).map(([label, value]) => <div key={label}>
      <dt>{label}</dt><dd>{value}</dd>
    </div>)}</dl>
  </section>;
}

function EncodingDiagnosticsSection({ diagnostics }: { diagnostics: ReadonlyMap<string, P2pEncodingDiagnostics> }) {
  const { t } = useI18n();
  return <section className="webrtc-stats-detail">
    <h3>{t('stats.encodingDiagnostics')}</h3>
    {[...diagnostics.entries()].map(([identity, state]) => <section key={identity}>
      <h4>{identity}</h4>
      <dl>
        <div><dt>{t('stats.selectedProvider')}</dt><dd>{state.provider ?? '—'}</dd></div>
        <div><dt>{t('stats.profileTarget')}</dt><dd>{bitrate(state.profileTargetBitrateBps)}</dd></div>
        <div><dt>{t('stats.transportCap')}</dt><dd>{bitrate(state.transportBitrateCapBps)}</dd></div>
        <div><dt>{t('stats.scale')}</dt><dd>{state.scaleResolutionDownBy.toFixed(2)}×</dd></div>
      </dl>
    </section>)}
  </section>;
}

function format(value?: number): string | undefined {
  return value === undefined ? undefined : String(value);
}

function unit(value: number | undefined, suffix: string): string | undefined {
  return value === undefined ? undefined : `${value} ${suffix}`;
}

function bitrate(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${Number((value / 1_000_000).toFixed(2))} Mbps`;
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
