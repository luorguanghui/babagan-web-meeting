import { afterEach, expect, it, vi } from 'vitest';
import { ProjectPeerSender } from './peer-sender.js';
afterEach(() => vi.useRealTimers());
it('reports capture and transport losses to the viewer using the existing stats message', async () => {
  vi.useFakeTimers();
  const messages: string[] = [];
  const control = { readyState: 'open', send(raw: string) { messages.push(raw); }, close() {} };
  const media = { readyState: 'open', close() {} };
  const sender = new ProjectPeerSender({ pc: { createDataChannel: (label: string) => label.includes('control') ? control : media } as unknown as RTCPeerConnection,
    stream: { getVideoTracks: () => [{}], getAudioTracks: () => [] } as unknown as MediaStream,
    options: { codec: 'h264', frameRate: 60, maxBitrate: 8000000 }, onError(message) { throw new Error(message); } });
  const internal = sender as unknown as { encoder: { stats: Record<string, number>; start(): Promise<void> }; begin(): Promise<void> };
  vi.spyOn(internal.encoder, 'start').mockResolvedValue();
  Object.assign(internal.encoder.stats, { width: 1920, height: 1080, queueDrops: 3, expiredDrops: 2, droppedFrames: 41 });
  await internal.begin();
  await vi.advanceTimersByTimeAsync(1000);
  expect(JSON.parse(messages[0])).toMatchObject({ type: 'stats', queueDrops: 44, expiredDrops: 2 });
  await sender.close();
});
