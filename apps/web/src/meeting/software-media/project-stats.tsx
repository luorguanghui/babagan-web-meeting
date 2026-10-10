import { useI18n } from '../../i18n/i18n.js';
import type { ProjectStats } from './encoder.js';
export function ProjectMediaSection({ stats, onResumeAudio }: { stats: ProjectStats; onResumeAudio?: () => void }) {
  const { t } = useI18n();
  return <section><h3>{stats.codec === 'h264' ? 'WASM / OpenH264' : 'WASM / libvpx'}</h3><dl>
    <div><dt>{t('stats.encoderImplementation')}</dt><dd>{stats.codec === 'h264' ? 'OpenH264 2.6.0' : 'libvpx / libav.js 6.10.9'}</dd></div>
    <div><dt>{t('stats.resolution')}</dt><dd>{stats.width} × {stats.height}</dd></div>
    <div><dt>{t('stats.encodedFps')}</dt><dd>{stats.encodedFps?.toFixed(1) ?? '—'}</dd></div>
    <div><dt>{t('stats.fps')}</dt><dd>{stats.renderedFps?.toFixed(1) ?? '—'}</dd></div>
    <div><dt>{t('stats.bitrate')}</dt><dd>{stats.encodedBps === undefined ? '—' : (stats.encodedBps / 1000000).toFixed(2) + ' Mbps'}</dd></div>
    <div><dt>{t('stats.projectOutputFrames')}</dt><dd>{stats.encodedFrames}</dd></div>
    <div><dt>{t('stats.projectReadFrames')}</dt><dd>{stats.rawFrames}</dd></div>
    <div><dt>{t('stats.projectDecodedFrames')}</dt><dd>{stats.decodedFrames}</dd></div>
    <div><dt>{t('stats.projectRenderedFrames')}</dt><dd>{stats.renderedFrames}</dd></div>
    <div><dt>{t('stats.encodeTime')}</dt><dd>{stats.encodeMs.toFixed(2)} ms</dd></div>
    <div><dt>{t('stats.projectDrops')}</dt><dd>{stats.queueDrops + stats.expiredDrops + stats.droppedFrames}</dd></div>
    <div><dt>{t('stats.encoderTarget')}</dt><dd>{(stats.videoBps / 1000000).toFixed(2)} Mbps</dd></div>
    <div><dt>{t('stats.projectWireCap')}</dt><dd>{(stats.wireBps / 1000000).toFixed(2)} Mbps</dd></div>
    <div><dt>{t('stats.projectSpatialFilter')}</dt><dd>{stats.filter}×</dd></div>
  </dl>{stats.audioBlocked && onResumeAudio && <button type="button" onClick={onResumeAudio}>{t('controls.resumeAudio')}</button>}</section>;
}
