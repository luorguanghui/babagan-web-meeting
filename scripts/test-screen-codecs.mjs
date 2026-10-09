/* global URL */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const artifact = new URL('../artifacts/screen-codecs/openh264-2.6.0/encoder-single.mjs', import.meta.url);

test('OpenH264 outputs each input without rate-control skipping and forces recovery IDR', async () => {
  assert.ok(existsSync(artifact), 'build the project OpenH264 module before accepting software encoding');
  const { default: createEncoder } = await import(artifact.href);
  const module = await createEncoder({ locateFile: name => fileURLToPath(new URL(name, artifact)) });
  assert.equal(module._screen_create(1919, 1080, 60, 8000000, 1), 0, 'reject odd chroma dimensions');
  assert.equal(module._screen_create(0, 1080, 60, 8000000, 1), 0);
  const handle = module._screen_create(320, 180, 60, 500000, 1);
  assert.ok(handle > 0, 'valid encoder initializes');
  const input = module._screen_input(handle);
  assert.ok(input > 0);
  for (let index = 0; index < 60; index++) {
    module.HEAPU8.fill(16 + index, input, input + 320 * 180);
    module.HEAPU8.fill(128, input + 320 * 180, input + 320 * 180 * 1.5);
    assert.equal(module._screen_encode(handle, index * 1000 / 60, index === 30 ? 1 : 0), 1, `frame ${index} produces bitstream`);
    const bytes = module.HEAPU8.slice(module._screen_output(handle), module._screen_output(handle) + module._screen_size(handle));
    assert.ok(bytes.length > 0);
    assert.deepEqual([...bytes.subarray(0, 4)], [0, 0, 0, 1], 'Annex B output, not MP4');
    if (index === 0 || index === 30) {
      assert.equal(module._screen_key(handle), 1, 'initial/recovery frame is IDR');
      assert.ok(bytes.some((value, offset) => offset >= 4 && (value & 31) === 7 && bytes[offset - 1] === 1), 'includes SPS');
    }
  }
  assert.equal(module._screen_set_bitrate(handle, 300000), 0, 'lower target without reinitializing');
  assert.equal(module._screen_set_bitrate(handle, 750000), 0, 'raise target above original initialization limit');
  assert.equal(module._screen_encode(handle, NaN, 0), -1, 'reject invalid timestamps before SDK conversion');
  module._screen_destroy(handle);
  module._screen_destroy(handle);
  assert.equal(module._screen_encode(handle, 1000, 0), -1, 'closed encoder cannot encode');
  const motion = module._screen_create_video(320, 180, 60, 500000, 1);
  assert.ok(motion > 0, 'motion video preset initializes independently');
  module.HEAPU8.fill(128, module._screen_input(motion), module._screen_input(motion) + 320 * 180 * 1.5);
  assert.equal(module._screen_encode(motion, 0, 0), 1);
  assert.equal(module._screen_key(motion), 1);
  module._screen_destroy(motion);
});

test('libvpx realtime adapter emits sixty distinct decodable VP8 frames', async () => {
  const { LibAV } = await import('../apps/web/node_modules/@libav.js/variant-vp8-opus/dist/libav-vp8-opus.mjs');
  const libav = await LibAV({ noworker: true });
  const [, context, frame, packet] = await libav.ff_init_encoder('libvpx', {
    ctx: { width: 320, height: 180, pix_fmt: libav.AV_PIX_FMT_YUV420P, bit_rate: 500000, time_base: [1, 60], framerate: [60, 1], gop_size: 120 },
    options: { deadline: 'realtime', 'cpu-used': '8', 'lag-in-frames': '0', 'auto-alt-ref': '0', 'dropframe-threshold': '0' }
  });
  const [, decoder, decodePacket, decodedFrame] = await libav.ff_init_decoder('libvpx');
  try {
    const values = new Set();
    for (let index = 0; index < 60; index++) {
      const data = new Uint8Array(320 * 180 * 1.5).fill(128);
      data.fill(16 + index * 3, 0, 320 * 180);
      const encoded = await libav.ff_encode_multi(context, frame, packet, [{
        data, layout: [{ offset: 0, stride: 320 }, { offset: 57600, stride: 160 }, { offset: 72000, stride: 160 }],
        format: libav.AV_PIX_FMT_YUV420P, width: 320, height: 180, pts: index, ptshi: 0, time_base_num: 1, time_base_den: 60
      }]);
      assert.equal(encoded.length, 1, `frame ${index} output immediately`);
      const output = await libav.ff_decode_multi(decoder, decodePacket, decodedFrame, encoded);
      assert.equal(output.length, 1);
      values.add(output[0].data[output[0].layout[0].offset]);
    }
    assert.equal(values.size, 60, 'decoded moving input rather than duplicated frames');
  } finally {
    await libav.ff_free_encoder(context, frame, packet);
    await libav.ff_free_decoder(decoder, decodePacket, decodedFrame);
    libav.terminate();
  }
});
