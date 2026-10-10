/// <reference lib="webworker" />
import { loadLibav, type LibavModule } from './codec.js';
import { opusEncoderOptions } from '../../../../../media/codec-options.mjs';
const scope = self as unknown as DedicatedWorkerGlobalScope;
let lib: LibavModule | undefined, encoder: [number, number, number, number, number] | undefined, closed = false;
let tail = Promise.resolve();
async function initialize(): Promise<void> {
  lib = await loadLibav(1);
  if (closed) { lib.terminate(); return; }
  encoder = await lib.ff_init_encoder('libopus', opusEncoderOptions(lib.AV_SAMPLE_FMT_FLT));
  scope.postMessage({ type: 'ready' });
}
scope.onmessage = ({ data }: MessageEvent<{ type: string; data?: Float32Array; timestampUs?: number }>) => {
  if (data.type === 'init') tail = initialize().catch(error => scope.postMessage({ type: 'error', message: String(error) }));
  else if (data.type === 'pcm') {
    tail = tail.then(async () => {
      if (closed || !lib || !encoder || !data.data || data.timestampUs === undefined) return;
      const pts = Math.round(data.timestampUs * 48000 / 1000000);
      const packets = await lib.ff_encode_multi(encoder[1], encoder[2], encoder[3], [{ data: data.data, format: lib.AV_SAMPLE_FMT_FLT,
        sample_rate: 48000, channels: 2, channel_layout: 3, nb_samples: 960, pts: pts % 0x100000000,
        ptshi: Math.floor(pts / 0x100000000), time_base_num: 1, time_base_den: 48000 }]);
      for (const packet of packets) {
        const bytes = packet.data.slice();
        scope.postMessage({ type: 'audio', data: bytes.buffer, timestampUs: data.timestampUs }, [bytes.buffer]);
      }
      scope.postMessage({ type: 'ack' });
    }).catch(error => scope.postMessage({ type: 'error', message: String(error) }));
  } else if (data.type === 'stop') {
    closed = true;
    void tail.finally(async () => {
      if (lib && encoder) await lib.ff_free_encoder(encoder[1], encoder[2], encoder[3]);
      lib?.terminate(); scope.postMessage({ type: 'stopped' });
    });
  }
};
