export const CLIENT_HOST_PROTOCOL = 1;
export interface ClientHostInfo {
  platform: 'windows' | 'android';
  appVersion: string;
  protocol: 1;
  screenCapture: boolean;
  systemAudio?: boolean;
}
export interface ClientHostRequest {
  v: 1; id: string;
  method: 'client.info' | 'meeting.state' | 'microphone.state' | 'update.check' | 'capture.start' | 'capture.signal' | 'capture.stop';
  params?: Record<string, unknown>;
}
export interface ClientHostResponse {
  v: 1; id: string; ok: boolean; result?: unknown; error?: { code: string; message: string };
}
export interface ClientHostEvent { v: 1; event: string; sessionId?: string; [key: string]: unknown }
