import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opusEncoderOptions } from '../media/codec-options.mjs';
test('project Opus emits immediate 20ms stereo packets within the 128kbps budget', async () => {
  const { LibAV } = await import('../apps/web/node_modules/@libav.js/variant-vp8-opus/dist/libav-vp8-opus.mjs');
  const lib = await LibAV({ noworker: true });
  const [, ctx, frame, packet] = await lib.ff_init_encoder('libopus', opusEncoderOptions(lib.AV_SAMPLE_FMT_FLT));
  try {
    let bytes = 0;
    for (let i = 0; i < 50; i++) {
      const data = new Float32Array(1920);
      for (let j = 0; j < 960; j++) data[j * 2] = data[j * 2 + 1] = Math.sin((i * 960 + j) * 2 * Math.PI * 440 / 48000) * .2;
      const output = await lib.ff_encode_multi(ctx, frame, packet, [{ data, format: lib.AV_SAMPLE_FMT_FLT, sample_rate: 48000, channels: 2, channel_layout: 3,
        nb_samples: 960, pts: i * 960, ptshi: 0, time_base_num: 1, time_base_den: 48000 }]);
      assert.equal(output.length, 1);
      bytes += output[0].data.length;
    }
    assert.ok(bytes * 8 <= 128000);
  } finally { await lib.ff_free_encoder(ctx, frame, packet); lib.terminate(); }
});
