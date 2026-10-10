/// <reference lib="webworker" />
import { ProjectVideoCodec } from './codec.js';
import { FrameQueue } from './frame-queue.js';
import { encodeDimensions, frameToI420 } from './pixels.js';
const scope = self as unknown as DedicatedWorkerGlobalScope;
type Options = { codec: 'h264' | 'vp8'; width: number; height: number; fps: number; bitrate: number; threads: number };
type Incoming = { type: 'init'; options: Options } | { type: 'frame'; frame: VideoFrame; timestampUs: number; capturedAt: number }
  | { type: 'keyframe' | 'stop' } | { type: 'bitrate'; bitrate: number };
interface Item { frame: VideoFrame; timestampUs: number; close(): void; }
const queue = new FrameQueue<Item>();
let options: Options, codec: ProjectVideoCodec | undefined, initialization: Promise<void> | undefined;
let running: Promise<void> | undefined, stopped = false, forceKey = true, lastKeyUs = 0, pendingBitrate: number | undefined;
let revision = 0, encodedFrames = 0, encodedBytes = 0, encodeMs = 0, skipped = 0;
const epoch = () => performance.timeOrigin + performance.now();
function post(data: unknown, transfers: Transferable[] = []): void { scope.postMessage(data, transfers); }
async function initialize(settings: Options): Promise<void> {
  options = { ...settings };
  const dimensions = encodeDimensions(settings.width, settings.height);
  codec = new ProjectVideoCodec({ ...settings, ...dimensions });
  await codec.initialize();
  revision++;
  if (!stopped) post({ type: 'ready' });
}
async function drain(): Promise<void> {
  while (!stopped && queue.length) {
    const before = queue.expiredDrops, item = queue.take(epoch());
    if (queue.expiredDrops !== before) post({ type: 'ack', count: queue.expiredDrops - before, expired: true });
    if (!item) continue;
    try {
      if (!codec) throw new Error('Project encoder is not ready');
      const dimensions = encodeDimensions(item.frame.frame.displayWidth, item.frame.frame.displayHeight);
      if (dimensions.width !== codec.options.width || dimensions.height !== codec.options.height) {
        await codec.close(); codec = new ProjectVideoCodec({ ...options, ...dimensions });
        await codec.initialize(); revision++; forceKey = true;
      }
      if (pendingBitrate !== undefined) {
        options.bitrate = pendingBitrate; pendingBitrate = undefined;
        await codec.setBitrate(options.bitrate);
        if (options.codec === 'vp8') { revision++; forceKey = true; }
      }
      const start = performance.now();
      const pixels = await frameToI420(item.frame.frame, dimensions.width, dimensions.height);
      if (stopped || epoch() - item.capturedAt > 150) { post({ type: 'expired' }); continue; }
      const packet = await codec.encode(pixels, item.frame.timestampUs, forceKey || item.frame.timestampUs - lastKeyUs >= 2000000);
      const duration = performance.now() - start;
      if (stopped) continue;
      if (!packet) { skipped++; post({ type: 'skip', skipped }); continue; }
      if (packet.keyframe) { lastKeyUs = item.frame.timestampUs; forceKey = false; }
      encodedFrames++; encodedBytes += packet.data.length; encodeMs += duration;
      post({ type: 'video', data: packet.data.buffer, timestampUs: item.frame.timestampUs, keyframe: packet.keyframe,
        codec: codec.codecString, width: dimensions.width, height: dimensions.height, revision,
        stats: { encodedFrames, encodedBytes, encodeMs: encodeMs / encodedFrames, filter: codec.filter,
          expiredDrops: queue.expiredDrops, queueDrops: queue.queueDrops, skipped } }, [packet.data.buffer]);
    } catch (error) { post({ type: 'error', message: String(error) }); stopped = true; }
    finally { item.frame.close(); post({ type: 'ack', count: 1 }); }
  }
  if (stopped) queue.clear();
}
scope.onmessage = ({ data: message }: MessageEvent<Incoming>) => {
  if (message.type === 'init') {
    initialization = initialize(message.options).catch(error => { stopped = true; post({ type: 'error', message: String(error) }); });
  } else if (message.type === 'frame') {
    if (stopped) { message.frame.close(); post({ type: 'ack', count: 1 }); return; }
    queue.push({ frame: message.frame, timestampUs: message.timestampUs, close: () => message.frame.close() }, message.capturedAt);
    if (!running) {
      running = Promise.resolve(initialization).then(drain).finally(() => { running = undefined; });
    }
  } else if (message.type === 'keyframe') forceKey = true;
  else if (message.type === 'bitrate') pendingBitrate = message.bitrate;
  else if (message.type === 'stop') {
    stopped = true; queue.clear();
    void Promise.all([initialization, running]).then(async () => { await codec?.close(); post({ type: 'stopped' }); });
  }
};
