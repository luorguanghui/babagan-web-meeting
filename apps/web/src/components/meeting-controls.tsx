import type { MeetingConnectionState } from '../meeting/room-controller.js';
import type { CaptureProfile } from '../meeting/screen-share.js';

interface MeetingControlsProps {
  connection: MeetingConnectionState;
  microphoneEnabled: boolean;
  audioPlaybackBlocked: boolean;
  devices: MediaDeviceInfo[];
  leaving: boolean;
  screenShareAuthorized?: boolean;
  screenShareActive?: boolean;
  screenShareBusy?: boolean;
  screenProfile?: CaptureProfile;
  onMicrophoneToggle: () => void;
  onMicrophoneDeviceChange: (deviceId: string) => void;
  onSpeakerDeviceChange: (deviceId: string) => void;
  onResumeAudio: () => void;
  onScreenProfileChange?: (profile: CaptureProfile) => void;
  onScreenShareToggle?: () => void;
  onLeave: () => void;
}

export function MeetingControls(props: MeetingControlsProps) {
  const microphoneDevices = props.devices.filter((device) => device.kind === 'audioinput');
  const speakerDevices = props.devices.filter((device) => device.kind === 'audiooutput');
  return <footer className="meeting-controls" aria-label="Meeting controls">
    <p role="status">Connection: {props.connection}</p>
    <button type="button" onClick={props.onMicrophoneToggle} disabled={props.connection !== 'connected'}>
      {props.microphoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
    </button>
    <label>Microphone device<select aria-label="Microphone device" defaultValue="" onChange={(event) => props.onMicrophoneDeviceChange(event.target.value)}>
      <option value="" disabled>Select microphone</option>
      {microphoneDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Microphone'}</option>)}
    </select></label>
    <label>Speaker device<select aria-label="Speaker device" defaultValue="" onChange={(event) => props.onSpeakerDeviceChange(event.target.value)}>
      <option value="" disabled>Select speaker</option>
      {speakerDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Speaker'}</option>)}
    </select></label>
    {props.audioPlaybackBlocked && <button type="button" onClick={props.onResumeAudio}>点击恢复声音</button>}
    <label>Screen quality<select
      aria-label="Screen quality"
      value={props.screenProfile ?? 'standard'}
      disabled={props.screenShareActive || props.screenShareBusy}
      onChange={(event) => props.onScreenProfileChange?.(event.target.value as CaptureProfile)}
    >
      <option value="standard">Standard (1080p30)</option>
      <option value="motion">High motion (1080p60)</option>
    </select></label>
    <button
      type="button"
      aria-label={props.screenShareActive ? 'Stop sharing screen' : 'Share screen'}
      title={props.screenShareAuthorized ? undefined : 'A host must grant screen sharing before capture can start.'}
      disabled={!props.screenShareAuthorized || props.screenShareBusy || props.connection !== 'connected'}
      onClick={props.onScreenShareToggle}
    >{props.screenShareActive ? 'Stop sharing' : 'Share screen'}</button>
    <button type="button" className="danger" onClick={props.onLeave} disabled={props.leaving}>{props.leaving ? 'Leaving…' : 'Leave meeting'}</button>
  </footer>;
}
