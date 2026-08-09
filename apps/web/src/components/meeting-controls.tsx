import type { ScreenShareCodec } from '@meeting/contracts';

import { useI18n } from '../i18n/i18n.js';
import type { MeetingConnectionState } from '../meeting/room-controller.js';
import type { CaptureProfile, MotionBitrate } from '../meeting/screen-share.js';

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
  screenProfile?: CaptureProfile;
  screenCodec?: ScreenShareCodec;
  screenBitrate?: MotionBitrate;
  onMicrophoneToggle: () => void;
  onMicrophoneDeviceChange: (deviceId: string) => void;
  onSpeakerDeviceChange: (deviceId: string) => void;
  onResumeAudio: () => void;
  onScreenProfileChange?: (profile: CaptureProfile) => void;
  onScreenCodecChange?: (codec: ScreenShareCodec) => void;
  onScreenBitrateChange?: (bitrate: MotionBitrate) => void;
  onScreenShareToggle?: () => void;
  onLeave: () => void;
}

export function MeetingControls(props: MeetingControlsProps) {
  const { t } = useI18n();
  const microphoneDevices = props.devices.filter((device) => device.kind === 'audioinput');
  const speakerDevices = props.devices.filter((device) => device.kind === 'audiooutput');
  return <footer className={['meeting-controls', props.className].filter(Boolean).join(' ')} aria-label={t('controls.label')}>
    <p role="status">{t('controls.connection', { state: props.connection })}</p>
    <p className="sr-only" role="status">{t('controls.microphoneStatus', { state: props.microphoneEnabled ? t('common.on') : t('common.muted') })}</p>
    <p className="sr-only" role="status">{t('controls.screenStatus', { state: props.screenShareActive ? t('common.on') : t('common.off') })}</p>
    <button type="button" onClick={props.onMicrophoneToggle} disabled={props.connection !== 'connected'}>
      {props.microphoneEnabled ? t('controls.mute') : t('controls.unmute')}
    </button>
    <label>{t('controls.microphoneDevice')}<select aria-label={t('controls.microphoneDevice')} defaultValue="" onChange={(event) => props.onMicrophoneDeviceChange(event.target.value)}>
      <option value="" disabled>{t('controls.selectMicrophone')}</option>
      {microphoneDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || t('controls.microphone')}</option>)}
    </select></label>
    <label>{t('controls.speakerDevice')}<select aria-label={t('controls.speakerDevice')} defaultValue="" onChange={(event) => props.onSpeakerDeviceChange(event.target.value)}>
      <option value="" disabled>{t('controls.selectSpeaker')}</option>
      {speakerDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || t('controls.speaker')}</option>)}
    </select></label>
    {props.audioPlaybackBlocked && <button type="button" onClick={props.onResumeAudio}>{t('controls.resumeAudio')}</button>}
    <label>{t('controls.screenQuality')}<select
      aria-label={t('controls.screenQuality')}
      value={props.screenProfile ?? 'standard'}
      disabled={props.screenShareActive || props.screenShareBusy}
      onChange={(event) => props.onScreenProfileChange?.(event.target.value as CaptureProfile)}
    >
      <option value="standard">{t('controls.standard')}</option>
      <option value="motion">{t('controls.motion')}</option>
    </select></label>
    {(props.screenProfile ?? 'standard') === 'motion' && <label>{t('controls.screenBitrate')}<select
      aria-label={t('controls.screenBitrate')}
      value={props.screenBitrate ?? 10_000_000}
      disabled={props.screenShareActive || props.screenShareBusy}
      onChange={(event) => props.onScreenBitrateChange?.(Number(event.target.value) as MotionBitrate)}
    >
      <option value={10_000_000}>10 Mbps</option>
      <option value={13_000_000}>13 Mbps</option>
      <option value={15_000_000}>15 Mbps</option>
    </select></label>}
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
    <button
      type="button"
      aria-label={props.screenShareActive ? t('controls.stopShare') : t('controls.share')}
      title={props.screenShareAuthorized ? undefined : t('controls.shareGrantRequired')}
      disabled={!props.screenShareAuthorized || props.screenShareBusy || props.connection !== 'connected'}
      onClick={props.onScreenShareToggle}
    >{props.screenShareActive ? t('controls.stopShareShort') : t('controls.shareShort')}</button>
    <button type="button" className="danger" onClick={props.onLeave} disabled={props.leaving}>{props.leaving ? t('controls.leaving') : t('controls.leave')}</button>
  </footer>;
}
