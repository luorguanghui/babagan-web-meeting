/* global URL */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { vp8EncoderOptions } from '../media/codec-options.mjs';

const width = 640, height = 360, fps = 60, bitrate = 1000000;
function texture(index) {
  const data = new Uint8Array(width * height * 1.5).fill(128);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    data[y * width + x] = 16 + (((x + index * 11) * 3 ^ (y + index * 7) * 5) % 220);
  }
  return data;
}

test('OpenH264 constrains sustained dynamic output instead of merely reporting a target bitrate', async () => {
  const location = new URL('../artifacts/screen-codecs/openh264-2.6.0/encoder-single.mjs', import.meta.url);
  const { default: create } = await import(location);
  const module = await create({ locateFile: name => fileURLToPath(new URL(name, location)) });
  const handle = module._screen_create_video(width, height, fps, bitrate, 1);
  assert.ok(handle > 0);
  let measuredBytes = 0;
  try {
    for (let index = 0; index < 360; index++) {
      module.HEAPU8.set(texture(index), module._screen_input(handle));
      assert.equal(module._screen_encode(handle, index * 1000 / fps, 0), 1, 'internal skip stays disabled');
      if (index >= 120) measuredBytes += module._screen_size(handle);
    }
    const actualBps = measuredBytes * 8 / 4;
    assert.ok(actualBps <= bitrate * 1.15, `actual ${actualBps} bps exceeds ${bitrate} target after warm-up`);
  } finally { module._screen_destroy(handle); }
});

test('VP8 uses the real 60fps time base and constrains dynamic output', async () => {
  const { LibAV } = await import('../apps/web/node_modules/@libav.js/variant-vp8-opus/dist/libav-vp8-opus.mjs');
  const libav = await LibAV({ noworker: true });
  const [, context, frame, packet] = await libav.ff_init_encoder('libvpx', vp8EncoderOptions({ width, height, fps, bitrate }));
  try {
    assert.equal(await libav.AVCodecContext_time_base_den(context), 60, 'rate model must use frame clock');
    let measuredBytes = 0;
    for (let index = 0; index < 360; index++) {
      const encoded = await libav.ff_encode_multi(context, frame, packet, [{ data: texture(index),
        layout: [{ offset: 0, stride: width }, { offset: width * height, stride: width / 2 }, { offset: width * height * 1.25, stride: width / 2 }],
        format: libav.AV_PIX_FMT_YUV420P, width, height, pts: index, ptshi: 0, time_base_num: 1, time_base_den: fps }]);
      assert.equal(encoded.length, 1);
      if (index >= 120) measuredBytes += encoded[0].data.length;
    }
    assert.ok(measuredBytes * 8 / 4 <= bitrate * 1.15, 'actual video payload stays near target');
  } finally { await libav.ff_free_encoder(context, frame, packet); libav.terminate(); }
});

test('H264 bounds hostile 1080p texture through declared spatial quality reduction, never hidden skips', async () => {
  const location = new URL('../artifacts/screen-codecs/openh264-2.6.0/encoder-single.mjs', import.meta.url);
  const { default: create } = await import(location);
  const module = await create({ locateFile: name => fileURLToPath(new URL(name, location)) });
  const w = 1920, h = 1080, target = 5000000;
  const handle = module._screen_create_video(w, h, 60, target, 1);
  const inputs = Array.from({ length: 8 }, (_, index) => {
    const data = new Uint8Array(w * h * 1.5).fill(128);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = 16 + (((x + index * 13) * 3 ^ (y + index * 7) * 5) % 220);
    return data;
  });
  let bytes = 0;
  try {
    for (let index = 0; index < 240; index++) {
      module.HEAPU8.set(inputs[index % inputs.length], module._screen_input(handle));
      assert.equal(module._screen_encode(handle, index * 1000 / 60, 0), 1);
      if (index >= 120) bytes += module._screen_size(handle);
    }
    assert.ok(bytes * 8 / 2 <= target * 1.15, `HD output ${bytes * 8 / 2} exceeds ${target} budget`);
    assert.ok(module._screen_filter(handle) >= 1, 'actual preprocessing ratio is available for UI/report');
  } finally { module._screen_destroy(handle); }
});
