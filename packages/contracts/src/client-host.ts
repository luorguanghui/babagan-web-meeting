export const CLIENT_HOST_PROTOCOL = 1;
export interface ClientHostInfo {
  platform: 'windows' | 'android';
  appVersion: string;
  protocol: 1;
  screenCapture: boolean;
  systemAudio?: boolean;
  /** Absent on older Android clients, whose native capture is limited to 30 fps. */
  maxScreenFrameRate?: 30 | 60;
  /** Explicit native Activity PiP support; absent on Android clients before 0.1.4. */
  pictureInPicture?: boolean;
  /** Native Android communication route selection; microphone follows the selected route. */
  audioRouting?: boolean;
}
export type ClientAudioDeviceType = 'default' | 'speaker' | 'earpiece' | 'bluetooth' | 'wired' | 'usb';
export interface ClientAudioDevice { id: string; label: string; type: ClientAudioDeviceType; }
export interface ClientAudioRoutes {
  revision: number;
  devices: ClientAudioDevice[];
  selectedId: string;
  /** Retained native preference, which can differ while the system overrides the actual route. */
  requestedId?: string;
  actualDeviceId: string | null;
  pendingId: string | null;
  bluetoothPermission: 'not-required' | 'required' | 'granted' | 'denied';
  microphoneFollowsOutput: true;
  canSelect: boolean;
}
export interface ClientHostRequest {
  v: 1; id: string;
  method: 'client.info' | 'meeting.state' | 'microphone.state' | 'update.check' | 'capture.start' | 'capture.signal' | 'capture.stop'
    | 'pictureInPicture.enter' | 'pictureInPicture.exit' | 'pictureInPicture.update'
    | 'audio.routes' | 'audio.select' | 'audio.bluetoothPermission';
  params?: Record<string, unknown>;
}
export interface ClientHostResponse {
  v: 1; id: string; ok: boolean; result?: unknown; error?: { code: string; message: string };
}
export interface ClientHostEvent { v: 1; event: string; sessionId?: string; [key: string]: unknown }
