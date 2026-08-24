import type { ScreenShareCodec, ScreenShareQuality } from '@meeting/contracts';
import { Ellipsis, LogOut, Mic, MicOff, MonitorUp, Volume2 } from 'lucide-react';
import type { RefObject } from 'react';

import { useI18n } from '../i18n/i18n.js';
import type { MeetingConnectionState } from '../meeting/room-controller.js';
import type { ViewerTransportPreference } from '../meeting/viewer-transport-preference.js';
import {
  recommendP2pBitrate,
  screenShareBitrates,
  screenShareDefaultBitrate,
  screenShareDefaultQuality,
  type ScreenShareBitrate
} from '../meeting/screen-share.js';

export interface MeetingControlsProps {
  className?: string;
  connection: MeetingConnectionState;
  microphoneEnabled: boolean;
  audioPlaybackBlocked: boolean;
  callAudioVolume?: number;
  sharedAudioVolume?: number;
  sharedAudioVolumeVisible?: boolean;
  devices: MediaDeviceInfo[];
  leaving: boolean;
  screenShareAuthorized?: boolean;
  screenShareActive?: boolean;
  screenShareBusy?: boolean;
  screenCodec?: ScreenShareCodec;
  screenBitrate?: ScreenShareBitrate;
  screenQuality?: ScreenShareQuality;
  screenViewerCount?: number;
  p2pRetryVisible?: boolean;
  viewerTransportPreferenceVisible?: boolean;
  viewerTransportPreference?: ViewerTransportPreference;
  onViewerTransportPreferenceChange?: (preference: ViewerTransportPreference) => void;
  onMicrophoneToggle: () => void;
  onMicrophoneDeviceChange: (deviceId: string) => void;
  onSpeakerDeviceChange: (deviceId: string) => void;
  onResumeAudio: () => void;
  onCallAudioVolumeChange?: (volume: number) => void;
  onSharedAudioVolumeChange?: (volume: number) => void;
  onScreenCodecChange?: (codec: ScreenShareCodec) => void;
  onScreenBitrateChange?: (bitrate: ScreenShareBitrate) => void;
  onScreenQualityChange?: (quality: ScreenShareQuality) => void;
  onScreenShareToggle?: () => void;
  onP2pRetry?: () => void;
  onOpenSharedVolume?: () => void;
  onMore?: () => void;
  moreButtonRef?: RefObject<HTMLButtonElement | null>;
  includeSettings?: boolean;
  onLeave: () => void;
}

export function MeetingControls(props: MeetingControlsProps) {
  const { t } = useI18n();
  const MicrophoneIcon = props.microphoneEnabled ? MicOff : Mic;
  return <footer className={['meeting-controls', props.className].filter(Boolean).join(' ')} aria-label={t('controls.label')}>
    <div className="meeting-control-status">
      <p role="status"><span className="meeting-status-dot" aria-hidden="true" />{t('controls.connection', { state: props.connection })}</p>
      <p className="meeting-adaptive-quality">{t('controls.adaptiveQuality')}</p>
      {props.audioPlaybackBlocked && <button className="meeting-resume-audio" type="button" onClick={props.onResumeAudio}>{t('controls.resumeAudio')}</button>}
    </div>
    <p className="sr-only" role="status">{t('controls.microphoneStatus', { state: props.microphoneEnabled ? t('common.on') : t('common.muted') })}</p>
    <p className="sr-only" role="status">{t('controls.screenStatus', { state: props.screenShareActive ? t('common.on') : t('common.off') })}</p>
    <div className="meeting-primary-toolbar" role="toolbar" aria-label={t('controls.primaryToolbar')}>
      <div className="meeting-primary-actions" role="group" aria-label={t('controls.primaryActions')}>
        <button type="button" className="meeting-action meeting-action-microphone" onClick={props.onMicrophoneToggle} disabled={props.connection !== 'connected'}>
          <MicrophoneIcon aria-hidden="true" size={19} />
          <span>{props.microphoneEnabled ? t('controls.mute') : t('controls.unmute')}</span>
        </button>
        <button
          type="button"
          className="meeting-action meeting-action-share"
          data-active={props.screenShareActive ? 'true' : 'false'}
          aria-label={props.screenShareActive ? t('controls.stopShare') : t('controls.share')}
          title={props.screenShareAuthorized ? undefined : t('controls.shareGrantRequired')}
          disabled={!props.screenShareAuthorized || props.screenShareBusy || props.connection !== 'connected'}
          onClick={props.onScreenShareToggle}
        ><MonitorUp aria-hidden="true" size={19} /><span>{props.screenShareActive ? t('controls.stopShareShort') : t('controls.shareShort')}</span></button>
        {props.sharedAudioVolumeVisible && props.onOpenSharedVolume && <button type="button" className="meeting-action meeting-action-volume" onClick={props.onOpenSharedVolume}>
          <Volume2 aria-hidden="true" size={19} /><span>{t('controls.sharedAudioVolume')}</span>
        </button>}
        {props.p2pRetryVisible && props.onP2pRetry && <button type="button" className="secondary" onClick={props.onP2pRetry}>{t('controls.p2pRetry')}</button>}
        {props.onMore && <button ref={props.moreButtonRef} type="button" className="meeting-action meeting-action-more" onClick={props.onMore}><Ellipsis aria-hidden="true" size={20} /><span>{t('controls.more')}</span></button>}
        <button type="button" className="danger meeting-leave-action" onClick={props.onLeave} disabled={props.leaving}>
          <LogOut aria-hidden="true" size={19} /><span>{props.leaving ? t('controls.leaving') : t('controls.leave')}</span>
        </button>
      </div>
    </div>
    {(props.includeSettings ?? true) && <details className="meeting-settings">
      <summary>{t('controls.settings')}</summary>
      <MeetingSettings {...props} />
    </details>}
  </footer>;
}

export function MeetingSettings(props: MeetingControlsProps) {
  const { t } = useI18n();
  const microphoneDevices = props.devices.filter((device) => device.kind === 'audioinput');
  const speakerDevices = props.devices.filter((device) => device.kind === 'audiooutput');
  return <div className="meeting-settings-grid">
    <label className="meeting-volume-control">
      <span className="meeting-volume-heading"><span>{t('controls.callAudioVolume')}</span><output>{props.callAudioVolume ?? 100}%</output></span>
      <input type="range" min="0" max="100" step="5" value={props.callAudioVolume ?? 100} aria-label={t('controls.callAudioVolume')} onChange={(event) => props.onCallAudioVolumeChange?.(Number(event.target.value))} />
    </label>
    {props.sharedAudioVolumeVisible && <label className="meeting-volume-control">
      <span className="meeting-volume-heading"><span>{t('controls.sharedAudioVolume')}</span><output>{props.sharedAudioVolume ?? 100}%</output></span>
      <input type="range" min="0" max="100" step="5" value={props.sharedAudioVolume ?? 100} aria-label={t('controls.sharedAudioVolume')} onChange={(event) => props.onSharedAudioVolumeChange?.(Number(event.target.value))} />
    </label>}
    <label>{t('controls.microphoneDevice')}<select aria-label={t('controls.microphoneDevice')} defaultValue="" onChange={(event) => props.onMicrophoneDeviceChange(event.target.value)}>
      <option value="" disabled>{t('controls.selectMicrophone')}</option>
      {microphoneDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || t('controls.microphone')}</option>)}
    </select></label>
    <label>{t('controls.speakerDevice')}<select aria-label={t('controls.speakerDevice')} defaultValue="" onChange={(event) => props.onSpeakerDeviceChange(event.target.value)}>
      <option value="" disabled>{t('controls.selectSpeaker')}</option>
      {speakerDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || t('controls.speaker')}</option>)}
    </select></label>
    {props.viewerTransportPreferenceVisible && props.onViewerTransportPreferenceChange && <label>{t('controls.viewerTransport')}<select aria-label={t('controls.viewerTransport')} value={props.viewerTransportPreference ?? 'auto'} onChange={(event) => props.onViewerTransportPreferenceChange?.(event.target.value as ViewerTransportPreference)}>
      <option value="auto">{t('controls.viewerTransportAuto')}</option><option value="turn">{t('controls.viewerTransportTurn')}</option><option value="sfu">{t('controls.viewerTransportSfu')}</option>
    </select></label>}
    <label>{t('controls.screenQuality')}<select aria-label={t('controls.screenQuality')} value={props.screenQuality ?? screenShareDefaultQuality} disabled={props.screenShareActive || props.screenShareBusy} onChange={(event) => props.onScreenQualityChange?.(event.target.value as ScreenShareQuality)}>
      <option value="flow">{t('controls.flow')}</option><option value="standard">{t('controls.standard')}</option><option value="motion">{t('controls.motion')}</option>
    </select></label>
    <label>{t('controls.screenCodec')}<select aria-label={t('controls.screenCodec')} value={props.screenCodec ?? 'h264'} disabled={props.screenShareActive || props.screenShareBusy} onChange={(event) => props.onScreenCodecChange?.(event.target.value as ScreenShareCodec)}>
      <option value="h264">{t('controls.codecH264')}</option><option value="auto">{t('controls.codecAuto')}</option><option value="vp8">{t('controls.codecVp8')}</option>
    </select></label>
    <label>{t('controls.screenBitrate')}<select aria-label={t('controls.screenBitrate')} value={props.screenBitrate ?? screenShareDefaultBitrate} disabled={props.screenShareActive || props.screenShareBusy} onChange={(event) => props.onScreenBitrateChange?.(Number(event.target.value) as ScreenShareBitrate)}>
      {screenShareBitrates.map((bitrate) => <option key={bitrate} value={bitrate}>{bitrate / 1_000_000} Mbps</option>)}
    </select><span className="meeting-controls-hint">{t('controls.p2pHint', { count: props.screenViewerCount ?? 0, bitrate: recommendP2pBitrate(props.screenViewerCount ?? 0) / 1_000_000 })}</span></label>
  </div>;
}
