import { describe, expect, it } from 'vitest';
import { sendControl, type ControlTransport } from './control-sender.js';

describe('bounded native control responses', () => {
  it('serializes controls when writable and drops stats instead of growing a stalled connection', () => {
    const received: string[] = [];
    let terminated = false;
    const transport: ControlTransport = { readyState: 1, bufferedAmount: 0,
      send(data) { received.push(data); }, terminate() { terminated = true; } };
    sendControl(transport, { type: 'stopped' });
    Object.assign(transport, { bufferedAmount: 16_385 });
    sendControl(transport, { type: 'stats', capturedFrames: 60, sentFrames: 50, droppedFrames: 10 });
    expect(received.map((value) => JSON.parse(value))).toEqual([{ type: 'stopped' }]);
    expect(terminated).toBe(false);
  });

  it('disconnects a reader that cannot receive required controls instead of accumulating responses', () => {
    let terminated = false;
    const received: string[] = [];
    const transport: ControlTransport = { readyState: 1, bufferedAmount: 16_385,
      send(data) { received.push(data); }, terminate() { terminated = true; } };
    sendControl(transport, { type: 'error', code: 'invalid_control', message: 'Invalid command.' });
    expect(received).toEqual([]);
    expect(terminated).toBe(true);
  });
});
