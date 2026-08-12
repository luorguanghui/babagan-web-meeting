import type { ScreenShareCodec, ScreenShareQuality } from '@meeting/contracts';

import { useI18n } from '../i18n/i18n.js';
import type { MeetingConnectionState } from '../meeting/room-controller.js';
import {
  recommendP2pBitrate,
  screenShareBitrates,
  screenShareDefaultBitrate,
  screenShareDefaultQuality,
  type ScreenShareBitrate
} from '../meeting/screen-share.js';

interface MeetingControlsProps {
  className?: string;
  connection: MeetingConnectionState;
  microphoneEnabled: boolean;
  audioPlaybackBlocked: boolean;
  devices: MediaDeviceInfo[];
  leaving: boolean;
  screenShareAuthorized?: boolean;
  screenShareActive?: boolean;
  screenShareBusy?: boolean;
  screenCodec?: ScreenShareCodec;
  screenBitrate?: ScreenShareBitrate;
  screenQuality?: ScreenShareQuality;
  /** Online viewer count driving the P2P bitrate suggestion. */
  screenViewerCount?: number;
  /** Whether the manual P2P retry button is shown (sharer while sharing, viewer on fallback). */
  p2pRetryVisible?: boolean;
  onMicrophoneToggle: () => void;
  onMicrophoneDeviceChange: (deviceId: string) => void;
  onSpeakerDeviceChange: (deviceId: string) => void;
  onResumeAudio: () => void;
  onScreenCodecChange?: (codec: ScreenShareCodec) => void;
  onScreenBitrateChange?: (bitrate: ScreenShareBitrate) => void;
  onScreenQualityChange?: (quality: ScreenShareQuality) => void;
  onScreenShareToggle?: () => void;
  /** Re-drives fresh P2P offers (the manual retry button). */
  onP2pRetry?: () => void;
  onLeave: () => void;
}

export function MeetingControls(props: MeetingControlsProps) {
  const { t } = useI18n();
  const microphoneDevices = props.devices.filter((device) => device.kind === 'audioinput');
  const speakerDevices = props.devices.filter((device) => device.kind === 'audiooutput');
  return <footer className={['meeting-controls', props.className].filter(Boolean).join(' ')} aria-label={t('controls.label')}>
    <div className="meeting-control-status">
      <p role="status"><span className="meeting-status-dot" aria-hidden="true" />{t('controls.connection', { state: props.connection })}</p>
      <p className="meeting-adaptive-quality">{t('controls.adaptiveQuality')}</p>
      {props.audioPlaybackBlocked && <button className="meeting-resume-audio" type="button" onClick={props.onResumeAudio}>{t('controls.resumeAudio')}</button>}
    </div>
    <p className="sr-only" role="status">{t('controls.microphoneStatus', { state: props.microphoneEnabled ? t('common.on') : t('common.muted') })}</p>
    <p className="sr-only" role="status">{t('controls.screenStatus', { state: props.screenShareActive ? t('common.on') : t('common.off') })}</p>
    <div className="meeting-primary-actions" role="group" aria-label={t('controls.primaryActions')}>
      <button type="button" onClick={props.onMicrophoneToggle} disabled={props.connection !== 'connected'}>
        {props.microphoneEnabled ? t('controls.mute') : t('controls.unmute')}
      </button>
      <button
        type="button"
        aria-label={props.screenShareActive ? t('controls.stopShare') : t('controls.share')}
        title={props.screenShareAuthorized ? undefined : t('controls.shareGrantRequired')}
        disabled={!props.screenShareAuthorized || props.screenShareBusy || props.connection !== 'connected'}
        onClick={props.onScreenShareToggle}
      >{props.screenShareActive ? t('controls.stopShareShort') : t('controls.shareShort')}</button>
      {props.p2pRetryVisible && props.onP2pRetry && <button type="button" className="secondary" onClick={props.onP2pRetry}>{t('controls.p2pRetry')}</button>}
      <button type="button" className="danger" onClick={props.onLeave} disabled={props.leaving}>{props.leaving ? t('controls.leaving') : t('controls.leave')}</button>
    </div>
    <details className="meeting-settings">
      <summary>{t('controls.settings')}</summary>
      <div className="meeting-settings-grid">
        <label>{t('controls.microphoneDevice')}<select aria-label={t('controls.microphoneDevice')} defaultValue="" onChange={(event) => props.onMicrophoneDeviceChange(event.target.value)}>
          <option value="" disabled>{t('controls.selectMicrophone')}</option>
          {microphoneDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || t('controls.microphone')}</option>)}
        </select></label>
        <label>{t('controls.speakerDevice')}<select aria-label={t('controls.speakerDevice')} defaultValue="" onChange={(event) => props.onSpeakerDeviceChange(event.target.value)}>
          <option value="" disabled>{t('controls.selectSpeaker')}</option>
          {speakerDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || t('controls.speaker')}</option>)}
        </select></label>
        <label>{t('controls.screenQuality')}<select
          aria-label={t('controls.screenQuality')}
          value={props.screenQuality ?? screenShareDefaultQuality}
          disabled={props.screenShareActive || props.screenShareBusy}
          onChange={(event) => props.onScreenQualityChange?.(event.target.value as ScreenShareQuality)}
        >
          <option value="flow">{t('controls.flow')}</option>
          <option value="standard">{t('controls.standard')}</option>
          <option value="motion">{t('controls.motion')}</option>
        </select></label>
        <label>{t('controls.screenCodec')}<select
          aria-label={t('controls.screenCodec')}
          value={props.screenCodec ?? 'h264'}
          disabled={props.screenShareActive || props.screenShareBusy}
          onChange={(event) => props.onScreenCodecChange?.(event.target.value as ScreenShareCodec)}
        >
          <option value="h264">{t('controls.codecH264')}</option>
          <option value="auto">{t('controls.codecAuto')}</option>
          <option value="vp8">{t('controls.codecVp8')}</option>
        </select></label>
        <label>{t('controls.screenBitrate')}<select
          aria-label={t('controls.screenBitrate')}
          value={props.screenBitrate ?? screenShareDefaultBitrate}
          disabled={props.screenShareActive || props.screenShareBusy}
          onChange={(event) => props.onScreenBitrateChange?.(Number(event.target.value) as ScreenShareBitrate)}
        >
          {screenShareBitrates.map((bitrate) => (
            <option key={bitrate} value={bitrate}>{bitrate / 1_000_000} Mbps</option>
          ))}
        </select>
        <span className="meeting-controls-hint">{t('controls.p2pHint', {
          count: props.screenViewerCount ?? 0,
          bitrate: recommendP2pBitrate(props.screenViewerCount ?? 0) / 1_000_000
        })}</span></label>
      </div>
    </details>
  </footer>;
}
