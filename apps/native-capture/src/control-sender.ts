import type { NativeCaptureMessage } from '@meeting/contracts';

export interface ControlTransport {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, options: { binary: false }): void;
  terminate(): void;
}

export function sendControl(transport: ControlTransport, message: NativeCaptureMessage): void {
  if (transport.readyState !== 1) return;
  if (transport.bufferedAmount > 16_384) {
    if (message.type !== 'stats') transport.terminate();
    return;
  }
  transport.send(JSON.stringify(message), { binary: false });
}
