import type { MeetingConnectionState } from '../meeting/room-controller.js';

interface MeetingControlsProps {
  connection: MeetingConnectionState;
  microphoneEnabled: boolean;
  audioPlaybackBlocked: boolean;
  devices: MediaDeviceInfo[];
  leaving: boolean;
  onMicrophoneToggle: () => void;
  onMicrophoneDeviceChange: (deviceId: string) => void;
  onSpeakerDeviceChange: (deviceId: string) => void;
  onResumeAudio: () => void;
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
    <button type="button" disabled aria-label="Share screen">Share screen</button>
    <button type="button" className="danger" onClick={props.onLeave} disabled={props.leaving}>{props.leaving ? 'Leaving…' : 'Leave meeting'}</button>
  </footer>;
}
