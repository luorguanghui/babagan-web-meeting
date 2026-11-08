/** Loopback-only helper protocol. The capability travels in a URL fragment, never a server query. */
export const NATIVE_CAPTURE_PROTOCOL = 'babagan-native-v1';
export const NATIVE_CAPTURE_PACKET_MAGIC = 0x424e4331;
export const NATIVE_CAPTURE_HEADER_BYTES = 16;
export const NATIVE_CAPTURE_MAX_PIXELS = 8_294_400;
export type NativeCaptureSourcePolicy = 'single-active-monitor';
export interface NativeCaptureSourceProof {
  kind: 'sole-active-monitor'; activeDisplayCount: 1; outputIndex: 0;
}
export interface NativeCaptureStart { frameRate: 30 | 60; sourcePolicy?: NativeCaptureSourcePolicy; }
export interface NativeCaptureFormat {
  type: 'format'; format: 'I420'; width: number; height: number; frameRate: 30 | 60;
  source?: NativeCaptureSourceProof;
}
export interface NativeCaptureCounters {
  type: 'stats'; capturedFrames: number; sentFrames: number; droppedFrames: number;
  /** Actual pixel changes, distinct from periodically sampled unchanged desktop frames. */
  contentChangedFrames?: number;
}
export type NativeCaptureMessage = NativeCaptureFormat | NativeCaptureCounters
  | { type: 'error'; code: string; message: string } | { type: 'stopped' };
// Binary messages: BE uint32 magic, BE uint32 sequence, BE float64 capture Unix microseconds,
// followed by exactly width*height*3/2 bytes of planar I420 BT.709 limited-range pixels.
