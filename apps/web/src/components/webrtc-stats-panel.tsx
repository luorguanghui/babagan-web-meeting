import type { P2pTurnProvider, ScreenShareCodec } from '@meeting/contracts';

import { type MessageKey, useI18n } from '../i18n/i18n.js';
import type { P2pEncodingDiagnostics } from '../meeting/p2p-share-controller.js';
import type { ScreenTransportMode, ScreenTurnProvider } from '../meeting/screen-transport-mode.js';
import type { WebRtcMediaStats, WebRtcStatsSnapshot } from '../meeting/webrtc-stats.js';
import { ProjectMediaSection } from '../meeting/software-media/project-stats.js';
import type { ProjectStats } from '../meeting/software-media/encoder.js';

const modeKeys: Record<ScreenTransportMode, MessageKey> = {
  'cloudflare-sfu': 'screenTransport.cloudflareSfu',
  p2p: 'screenTransport.p2p',
  turn: 'screenTransport.turn',
  sfu: 'screenTransport.sfu',
  mixed: 'screenTransport.mixed',
  negotiating: 'screenTransport.negotiating',
  waiting: 'screenTransport.waiting'
};
const turnProviderKeys: Record<ScreenTurnProvider, MessageKey> = {
  coturn: 'screenTransport.turnCoturn',
  mixed: 'screenTransport.turnMixed'
};

export function WebRtcStatsPanel({
  snapshot,
  requestedCodec,
  mode = 'sfu',
  turnProvider,
  encodingDiagnostics,
  projectReceiver,
  onProjectAudioResume,
  embedded = false,
  active = true
}: {
  snapshot?: WebRtcStatsSnapshot;
  requestedCodec: ScreenShareCodec;
  mode?: ScreenTransportMode;
  turnProvider?: P2pTurnProvider | 'mixed';
  encodingDiagnostics?: ReadonlyMap<string, P2pEncodingDiagnostics>;
  projectReceiver?: ProjectStats;
  onProjectAudioResume?: () => void;
  embedded?: boolean;
  active?: boolean;
}) {
  const { t } = useI18n();
  const transportKey = mode === 'turn' && turnProvider !== undefined
    ? turnProviderKeys[turnProvider]
    : modeKeys[mode];
  const hasMediaStats = Boolean(snapshot?.sender || snapshot?.receiver || projectReceiver);
  const hasEncodingDiagnostics = (encodingDiagnostics?.size ?? 0) > 0;
  const heading = <>
      <span>{t('stats.heading')}</span>
      <span className="webrtc-transport-badge" data-mode={mode} aria-live="polite">{t(transportKey)}</span>
    </>;
  const content = <>
    <p className="webrtc-stats-note">{t('stats.requestedCodec')}: {requestedCodec === 'auto' ? t('controls.codecAuto') : requestedCodec.toUpperCase()}</p>
    {!hasMediaStats && !hasEncodingDiagnostics
      ? <p>{t(active ? 'stats.collecting' : 'stats.noData')}</p>
      : <div className="webrtc-stats-grid">
        {snapshot?.sender && <StatsSection title={t('stats.sender')} stats={snapshot.sender} sender />}
        {snapshot?.receiver && <StatsSection title={t('stats.receiver')} stats={snapshot.receiver} />}
        {projectReceiver && <ProjectMediaSection stats={projectReceiver} onResumeAudio={onProjectAudioResume} />}
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
    [t('stats.captureFps'), sender ? format(stats.sourceFramesPerSecond) : undefined],
    [t(sender ? 'stats.encodedFps' : 'stats.decodedFps'), format(stats.framesPerSecond)],
    [t('stats.sentFps'), sender ? format(stats.sentFramesPerSecond) : undefined],
    [t('stats.receivedFps'), sender ? undefined : format(stats.receivedFramesPerSecond)],
    [sender ? t('stats.actualOutgoing') : t('stats.bitrate'), unit(stats.bitrateMbps, 'Mbps')],
    [sender ? t('stats.encoderTarget') : t('stats.bitrate'), unit(stats.encoderTargetBitrateMbps, 'Mbps')],
    [t('stats.packetLoss'), format(stats.packetsLost)],
    [t('stats.rtt'), unit(stats.roundTripTimeMs, 'ms')],
    [t('stats.droppedFrames'), format(stats.framesDropped)],
    [t('stats.freezes'), format(stats.freezeCount)],
    [t('stats.encodeTime'), unit(stats.averageEncodeTimeMs, 'ms')],
    [t('stats.intervalEncodeTime'), unit(stats.averageIntervalEncodeTimeMs, 'ms')],
    [t('stats.encoderImplementation'), stats.encoderImplementation],
    [t('stats.powerEfficientEncoder'), stats.powerEfficientEncoder === undefined ? undefined
      : t(stats.powerEfficientEncoder ? 'stats.yes' : 'stats.no')],
    [t('stats.decodeTime'), unit(stats.averageDecodeTimeMs, 'ms')],
    [t('stats.assemblyTime'), unit(stats.averageAssemblyTimeMs, 'ms')],
    [t('stats.decoderImplementation'), stats.decoderImplementation],
    [t('stats.powerEfficientDecoder'), stats.powerEfficientDecoder === undefined ? undefined
      : t(stats.powerEfficientDecoder ? 'stats.yes' : 'stats.no')],
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

function EncodingDiagnosticsSection({ diagnostics }: { diagnostics: ReadonlyMap<string, P2pEncodingDiagnostics> }) {
  const { t } = useI18n();
  return <section className="webrtc-stats-detail">
    <h3>{t('stats.encodingDiagnostics')}</h3>
    {[...diagnostics.entries()].map(([identity, state]) => <section key={identity}>
      <h4>{identity}</h4>
      {state.project && <ProjectMediaSection stats={state.project} />}
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
