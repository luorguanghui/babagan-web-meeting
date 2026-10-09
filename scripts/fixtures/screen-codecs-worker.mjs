/* global self, VideoFrame, VideoDecoder, EncodedVideoChunk, crossOriginIsolated, performance, navigator, setTimeout, fetch, crypto, TextDecoder */
// No browser video encoder is used; VideoFrame copy and VideoDecoder are allowed.
self.VideoEncoder = class { constructor() { throw new Error('Browser video encoder prohibited in benchmark'); } };
self.MediaRecorder = class { constructor() { throw new Error('Browser recorder prohibited in benchmark'); } };

function h264Codec(data) {
  for (let index = 4; index < data.length - 3; index++) {
    if ((data[index] & 31) === 7 && data[index - 1] === 1 && data[index - 2] === 0 && data[index - 3] === 0) {
      return `avc1.${[...data.subarray(index + 1, index + 4)].map(x => x.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  throw new Error('No SPS in initial H264 keyframe');
}

function makeInput(width, height, scene, index) {
  const data = new Uint8Array(width * height * 1.5);
  let seed = 314159;
  // Scene is generated before timing: tiled desktop/game-like texture with
  // independently translated tiles. Cyclic input is a throughput probe only.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const tile = ((x >> 7) + (y >> 6)) % 11;
    const shift = scene === 'static' ? 0 : index * (scene === 'texture' ? 3 : tile * 3 + 1);
    seed = Math.imul(seed, 1664525) + 1013904223;
    const xx = (x + shift) & 255;
    const yy = (y + shift * (scene === 'high-motion' ? tile + 1 : 1)) & 255;
    data[y * width + x] = 16 + ((xx * 3 ^ yy * 7 ^ tile * 17 ^ (seed >>> 26)) % 220);
  }
  data.fill(128, width * height);
  return data;
}

self.onmessage = async ({ data: options }) => {
  let module, libav, handle, encoder, decoder;
  const width = Number(options.width ?? 1920), height = Number(options.height ?? 1080);
  const codec = options.codec ?? 'h264', scene = options.scene ?? 'high-motion';
  const threads = Number(options.threads ?? 1), frames = Number(options.frames ?? 180);
  const fps = Number(options.fps ?? 60), bitrate = Number(options.bitrate ?? 8000000);
  const decodingEnabled = options.decode !== '0';
  const times = [], copyTimes = [], decodeTimes = [], bytesPerFrame = [];
  let decoded = 0, submitted = 0, skipped = 0, decoderCodec, firstKeyframe = false, lastKeyframe = false;
  try {
    if (!crossOriginIsolated) throw new Error('Benchmark needs isolation headers');
    const manifestResponse = await fetch(`/screen-codecs/${codec === 'h264' ? 'openh264-2.6.0' : 'libav-6.10.9'}/manifest.json`);
    if (!manifestResponse.ok) throw new Error('Verified codec manifest is unavailable');
    const manifestBytes = await manifestResponse.arrayBuffer();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const digest = await crypto.subtle.digest('SHA-256', manifestBytes);
    const build = { manifestSha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''), manifest };
    const inputs = Array.from({ length: scene === 'static' ? 1 : 16 }, (_, index) => makeInput(width, height, scene, index));
    if (codec === 'h264') {
      const { default: factory } = await import(`/screen-codecs/openh264-2.6.0/encoder-${threads === 1 ? 'single' : 'threads'}.mjs`);
      module = await factory();
      handle = (options.preset === 'video' ? module._screen_create_video : module._screen_create)(width, height, fps, bitrate, threads);
      if (!handle) throw new Error('OpenH264 initialization failed');
    } else {
      const { LibAV } = await import('/screen-codecs/libav-6.10.9/libav-6.10.9.0-vp8-opus.mjs');
      libav = await LibAV({ noworker: true, yesthreads: threads > 1 });
      encoder = await libav.ff_init_encoder('libvpx', {
        ctx: { width, height, pix_fmt: libav.AV_PIX_FMT_YUV420P, bit_rate: bitrate, time_base: [1, fps], framerate: [fps, 1], gop_size: fps * 2 },
        options: { threads: String(threads), deadline: 'realtime', 'cpu-used': '8', 'lag-in-frames': '0', 'auto-alt-ref': '0', 'dropframe-threshold': '0' }
      });
    }
    let decodeError;
    const decodeStart = new Map();
    if (decodingEnabled) decoder = new VideoDecoder({ output(frame) {
      decoded++;
      decodeTimes.push(performance.now() - decodeStart.get(frame.timestamp));
      decodeStart.delete(frame.timestamp);
      frame.close();
    }, error(error) { decodeError = String(error); } });
    let configured = false;
    const start = performance.now();
    for (let index = 0; index < frames; index++) {
      const frameStart = performance.now(), timestamp = Math.round(index * 1000000 / fps);
      const raw = new VideoFrame(inputs[index % inputs.length], { format: 'I420', codedWidth: width, codedHeight: height, timestamp });
      const input = new Uint8Array(raw.allocationSize());
      const layout = await raw.copyTo(input);
      raw.close();
      copyTimes.push(performance.now() - frameStart);
      let packet, key;
      const encodeStart = performance.now();
      if (codec === 'h264') {
        module.HEAPU8.set(input, module._screen_input(handle));
        const result = module._screen_encode(handle, timestamp / 1000, index === Math.floor(frames / 2) ? 1 : 0);
        if (result < 0) throw new Error(`OpenH264 encode failed ${result}`);
        if (result === 0) { skipped++; continue; }
        packet = module.HEAPU8.slice(module._screen_output(handle), module._screen_output(handle) + module._screen_size(handle));
        key = module._screen_key(handle) === 1;
      } else {
        const outputs = await libav.ff_encode_multi(encoder[1], encoder[2], encoder[3], [{
          data: input, layout, format: libav.AV_PIX_FMT_YUV420P, width, height,
          pts: index, ptshi: 0, time_base_num: 1, time_base_den: fps,
          pict_type: index === Math.floor(frames / 2) ? 1 : 0
        }]);
        if (outputs.length !== 1) { skipped++; continue; }
        packet = outputs[0].data;
        key = !!(outputs[0].flags & 1);
      }
      times.push(performance.now() - encodeStart);
      bytesPerFrame.push(packet.length);
      if (index === 0) firstKeyframe = key;
      if (index === Math.floor(frames / 2)) lastKeyframe = key;
      if (!configured) {
        decoderCodec = codec === 'h264' ? h264Codec(packet) : 'vp8';
        const config = { codec: decoderCodec, codedWidth: width, codedHeight: height, optimizeForLatency: true };
        if (decodingEnabled) {
          const support = await VideoDecoder.isConfigSupported(config);
          if (!support.supported) throw new Error(`Decoder unsupported: ${decoderCodec}`);
          decoder.configure(config);
        }
        configured = true;
      }
      if (decodeError) throw new Error(decodeError);
      if (decodingEnabled) {
        decodeStart.set(timestamp, performance.now());
        decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data: packet }));
      }
      submitted++;
      // Keep the decoder queue bounded; benchmark is not a live 60fps source.
      if (decoder?.decodeQueueSize >= 8) await new Promise(resolve => decoder.addEventListener('dequeue', resolve, { once: true }));
      if (index % 30 === 29) {
        self.postMessage({ status: 'running', codec, threads, scene, submitted, decoded, skipped });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    if (decodingEnabled) await decoder.flush();
    if (decodeError) throw new Error(decodeError);
    const elapsed = performance.now() - start;
    const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
    const meanEncode = times.reduce((a, b) => a + b, 0) / times.length;
    self.postMessage({ status: 'done', codec, scene, preset: options.preset ?? 'screen', width, height, threads, fps, bitrate, build, decodingEnabled, inputs: frames, submitted, decoded, skipped,
      firstKeyframe, recoveryKeyframe: lastKeyframe, decoderCodec, elapsedMs: elapsed, pipelineThroughputFps: submitted * 1000 / elapsed,
      encodeOnlyThroughputFps: 1000 / meanEncode, encodeMs: { mean: meanEncode, p50: percentile(times, .5), p95: percentile(times, .95) },
      copyMs: { p50: percentile(copyTimes, .5), p95: percentile(copyTimes, .95) }, decodeMs: { p50: percentile(decodeTimes, .5), p95: percentile(decodeTimes, .95) },
      meanFrameBytes: bytesPerFrame.reduce((a, b) => a + b, 0) / submitted, maxFrameBytes: Math.max(...bytesPerFrame),
      encodedBpsAtInputTimebase: bytesPerFrame.reduce((a, b) => a + b, 0) * 8 / (frames / fps),
      encodedBpsDuringProbe: bytesPerFrame.reduce((a, b) => a + b, 0) * 8 / (elapsed / 1000),
      wasmHeapBytes: module?.HEAPU8.byteLength ?? null, isolated: crossOriginIsolated, userAgent: navigator.userAgent,
      acceptance: 'throughput probe only; no claim of real capture, network, audio sync, or 180-second acceptance' });
  } catch (error) {
    self.postMessage({ status: 'error', codec, threads, scene, submitted, decoded, skipped, message: String(error), stack: error.stack });
  } finally {
    if (decoder && decoder.state !== 'closed') decoder.close();
    if (module && handle) module._screen_destroy(handle);
    if (libav && encoder) { await libav.ff_free_encoder(encoder[1], encoder[2], encoder[3]); libav.terminate(); }
  }
};
