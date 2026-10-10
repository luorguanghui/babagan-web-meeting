import { expect, it } from 'vitest';
import { ChannelSender } from './channel-sender.js';
const video = { kind: 'video' as const, id: 1, timestampUs: 1, keyframe: true, data: new Uint8Array(30000) };
function connection(bufferedAmount = 0) {
  let now = 0;
  const sent: Array<{ at: number; bytes: number }> = [];
  const channel = { bufferedAmount, readyState: 'open' as RTCDataChannelState, send(data: ArrayBuffer) { sent.push({ at: now, bytes: data.byteLength }); } };
  const clock = { now: () => now, async sleep(ms: number) { now += ms; } };
  return { channel, clock, sent, now: () => now };
}
it('paces actual fragment bytes and framing overhead rather than trusting encoder target', async () => {
  const link = connection();
  const sender = new ChannelSender(link.channel, 7, () => 12288, 2000000, link.clock);
  expect(await sender.send(video)).toBe(true);
  expect(link.sent.length).toBe(3);
  const last = link.sent.at(-1)!;
  expect(last.at).toBeGreaterThan(90);
  expect(link.sent.reduce((sum, item) => sum + item.bytes, 0)).toBe(30096);
});
it('refuses oversized frame budget before sending any partial reference frame', async () => {
  const link = connection();
  const sender = new ChannelSender(link.channel, 7, () => 12288, 1000000, link.clock);
  expect(await sender.send(video)).toBe(false);
  expect(link.sent.length).toBe(0);
});
it('isolates a stalled viewer from a healthy independent connection and bounds waiting', async () => {
  const blocked = connection(256 * 1024), healthy = connection();
  const slow = new ChannelSender(blocked.channel, 7, () => 12288, 8000000, blocked.clock);
  const fast = new ChannelSender(healthy.channel, 7, () => 12288, 8000000, healthy.clock);
  const outcomes = await Promise.all([slow.send(video), fast.send(video)]);
  expect(outcomes).toEqual([false, true]);
  expect(blocked.now()).toBeLessThanOrEqual(155);
  expect(blocked.sent.length).toBe(0);
  expect(healthy.sent.length).toBeGreaterThan(0);
});
it('stops queued traffic and reports failure after channel closure', async () => {
  const link = connection();
  const sender = new ChannelSender(link.channel, 7, () => 12288, 8000000, link.clock);
  sender.close();
  expect(await sender.send(video)).toBe(false);
  expect(link.sent.length).toBe(0);
});
it.each([8, 16])('sustains below-budget 60fps traffic with %ims minimum browser wakeups', async wakeupMs => {
  let now = 0;
  const sent: Array<{ at: number; bytes: number }> = [];
  const sender = new ChannelSender({ bufferedAmount: 0, readyState: 'open', send(data) { sent.push({ at: now, bytes: data.byteLength }); } },
    7, () => 12288, 8000000, { now: () => now, async sleep(ms) { now += Math.max(wakeupMs, ms); } });
  let dropped = 0;
  // 7.426 Mbps including framing and 12% transport allowance, below 8 Mbps.
  for (let index = 0; index < 600; index++) {
    now = Math.max(now, index * 1000 / 60);
    if (!await sender.send({ ...video, id: index, data: new Uint8Array(13750) })) dropped++;
  }
  expect(dropped).toBe(0);
  expect(now).toBeLessThan(10150);
  expect(sent.length).toBe(1200);
  const wireBytes = sent.reduce((sum, fragment) => sum + fragment.bytes, 0) * 1.12;
  expect(wireBytes * 8).toBeLessThan(8000000 * (now / 1000) + 2 * 12288 * 1.12 * 8);
});
it('bounds catch-up after a long idle interval instead of releasing an unlimited burst', async () => {
  const link = connection();
  const sender = new ChannelSender(link.channel, 7, () => 12288, 8000000, link.clock);
  await sender.send({ ...video, data: new Uint8Array(1000) });
  await link.clock.sleep(10000);
  const start = link.now();
  expect(await sender.send({ ...video, id: 2, data: new Uint8Array(100000) })).toBe(true);
  const burst = link.sent.filter(fragment => fragment.at === start);
  expect(burst.reduce((sum, fragment) => sum + fragment.bytes, 0)).toBeLessThanOrEqual(2 * 12288);
  expect(link.now() - start).toBeGreaterThan(80);
});
