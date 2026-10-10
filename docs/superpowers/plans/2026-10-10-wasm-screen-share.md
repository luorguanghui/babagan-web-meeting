# WASM 屏幕共享实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 用户已授权直接连续实施，无需逐步确认。

**Goal:** 用项目自带的 H.264（默认）和 VP8 编码替换 P2P 屏幕视频的浏览器编码，并保留声音、恢复和显式兼容路径。

**Architecture:** 用户修订：共享采集授权一次，每位观看者独立编码 Worker／数据通道及码率／路径／恢复，最多四路，沿用现有逐观看者控制逻辑。接收端有界组装、浏览器解码、共同音视频播放时钟；原有浏览器编码只用于显式兼容和 SFU。

**Tech Stack:** TypeScript、React、OpenH264 v2.6.0、Emscripten、libav.js vp8-opus 6.10.9、RTCDataChannel、WebCodecs、AudioWorklet。

**Spec:** `docs/superpowers/specs/2026-10-10-wasm-screen-share-design.md`

## Global Constraints

- H.264 和 VP8 都必须支持，默认 H.264；发送编码不调用 VideoEncoder 或 MediaRecorder。
- OpenH264 源码提交 `652bdb7719f30b52b08e506645a7322ff1b2cc6f`，frame skip=false，单层，实时低复杂度，线程 1–4，GOP 2 秒。
- 原始队列最多 6 帧、年龄 150 ms；媒体消息最多 12 KiB、单帧 2 MiB、分片 256；组装最多 8 帧/8 MiB/150 ms。
- 单观看者缓冲 256 KiB、等待 150 ms；关键帧请求间隔至少 500 ms；总上行 40 Mbps。
- Opus 48 kHz 双声道、20 ms、128 kbps；播放缓冲 100 ms，最大 200 ms。
- 180 秒真实输入测量保留 57 fps / p95 <=250 ms 目标，用户已允许按当前约44 fps 原型继续集成；发布报告真实帧率，不保证45/60。实际 5/8/10 Mbps 与总40 Mbps限制必须通过（含音频／开销），不得发送原型超高码率。
- 音视频 10 分钟偏差 <=80 ms，5 次重连恢复，30 分钟无无界增长；自托管资源、许可与哈希，隔离头变更必须实际部署。

## Review Focus

1. 数据通道中途断开、SCTP 消息上限过小：单观看者失败不得拖住其他人。
2. SPS 配置变化及旧 generation 的延迟包：不得送入新解码器。
3. AudioContext 自动播放被阻止：明确恢复入口，视频时钟不能永久等待。
4. 无隔离头、无 TrackProcessor 或解码能力：可识别的软件单线程/能力错误，不静默换编码器。
5. SFU 与数据通道快速切换、共享者撤销：首帧交接并完整释放旧资源。

### Task 1: 可复现编码器及可行性基准

**Files:** Create `media/openh264/encoder.cpp`, `scripts/build-screen-codecs.py`, `scripts/test-screen-codecs.mjs`, `scripts/benchmark-screen-codecs.mjs`, `media/codecs.lock.json`, `apps/web/public/screen-codecs/`; modify `apps/web/package.json`, `pnpm-lock.yaml`。

**Interfaces:** Produces C ABI `screen_create(width,height,fps,bitrate,threads)`, `screen_encode(handle,input,timestampMs,keyframe)`, output pointer/size/key/skip and `screen_destroy(handle)`. Libav 使用 `ff_init_encoder`/`ff_encode_multi`，输出 `{codec,data,keyframe,timestampUs}`。后续 Worker 消费同一 ABI。

- [ ] Write native ABI integration tests: 60 I420 inputs produce 60 decodable Annex B outputs, actual SPS codec string; forced IDR; invalid size/init failure and repeated destroy; VP8 60 inputs produce 60 decodable packets.
- [ ] Run `node scripts/test-screen-codecs.mjs`; Expected: fails because compiled adapters are absent.
- [ ] Pin official compiler and source versions; build single-thread and pthread artifacts plus licenses/source metadata. Test real memory ownership and release. No product integration before baseline.
- [ ] Run the ABI tests; Expected: successful decode with no skipped outputs. Run benchmark in actual Edge on static, moving texture and high-motion 1080p input, report throughput, p50/p95 and memory for 1–4 threads. Expected: measured evidence, never manufactured pass.
- [ ] Correct quantizer/time-base/rate control and add actual-rate regression tests before integration. Measure one and four independent encoders. Commit artifacts/build/test/report; user accepts continuing software route with actual fps reported, while actual bitrate remains a hard release gate.

### Task 2: 有界媒体协议与网络分发

**Files:** Create `apps/web/src/meeting/software-media/protocol.ts`, `assembler.ts`, `channel-sender.ts` and corresponding `.test.tsx`; modify `packages/contracts/src/p2p.ts` and tests.

**Interfaces:** Consumes encoded `{codec,data,keyframe,timestampUs}`. Produces `fragmentFrame(frame,generation,maxMessageSize): ArrayBuffer[]`, `FrameAssembler.push(message,now): EncodedFrame | null`, control config/capability/feedback types and `ChannelSender.send(frame): Promise<boolean>`.

- [ ] Write tests for malformed fields, duplicate/conflicting fragment, out-of-order assembly, stale generation, timeouts, memory bounds, small SCTP limits and isolated stalled viewer.
- [ ] Run `pnpm test --project web software-media`; Expected: feature assertions fail.
- [ ] Implement exact protocol/queue limits from Global Constraints and reliable control messages with schema validation.
- [ ] Run protocol tests and contract tests; Expected: all pass, including recovery requires keyframe.
- [ ] Commit validated protocol.

### Task 3: 编码 Worker、捕获和生命周期

**Files:** Create `apps/web/src/meeting/software-media/encoder-worker.ts`, `encoder.ts`, `capture.ts`, `types.ts` and tests; modify `p2p-share-controller.ts`, `screen-share.ts` and existing tests.

**Interfaces:** Consumes Task 1 ABI and Task 2 frame/control types. Produces `SoftwareScreenEncoder.start(track,options,onFrame)`, `requestKeyframe()`, `setBitrate(bps)`, `stop()`, actual capture/encode/drop statistics. P2P controller owns one encoder and per-viewer channels.

- [ ] Write tests for actual frame counters, queue 6/150 ms, close each frame exactly once, init error, resize, stop/restart, independent encoder per viewer and zero video RTP transceivers in software mode.
- [ ] Run targeted sharing tests; Expected: assertions fail with current native path.
- [ ] Implement Worker capture/conversion and codecs, explicit engine option; preserve native and explicit SFU modes. Data-channel open is not media-ready.
- [ ] Run targeted tests and actual two-peer Worker/DC/decode baseline; Expected: decoded distinct frames, no VideoEncoder/MediaRecorder/video RTP sender.
- [ ] Commit software publisher.

### Task 4: 接收端、共享声音与共同播放时钟

**Files:** Create `apps/web/src/meeting/software-media/receiver.ts`, `playback-clock.ts`, `audio-worker.ts`, `audio-capture-worklet.ts`, `audio-playback-worklet.ts`, `audio.ts` and tests; modify `p2p-viewer-controller.ts`, `components/screen-stage.tsx` and tests.

**Interfaces:** Consumes config/frames from Tasks 2–3. Produces local display stream/canvas source, volume control, actual decode/play statistics and first-frame readiness; microphone remains LiveKit.

- [ ] Write tests for generation/config changes, incomplete reference recovery, decoder cleanup, timestamp regressions, silence, autoplay blocked/resume, audio clock drift and SFU handover/revocation.
- [ ] Run receiver/audio/stage tests; Expected: feature assertions fail.
- [ ] Implement VideoDecoder/local track or canvas, Opus Worker and AudioWorklet, bounded 100–200 ms scheduler and common timestamps.
- [ ] Run tests plus real known video-marker/audio-pulse fixtures; Expected: distinct decoded frames, AV skew measured <=80 ms over 10 min and 5 reconnects, bounded queues.
- [ ] Commit receiving/playback.

### Task 5: 产品集成、部署资源与最终验收

**Files:** Modify `meeting-room-page.tsx`, WebRTC stats/settings components and tests, `infra/web/Caddyfile`, `infra/caddy/Caddyfile`, deployment Dockerfile/scripts, `docs/deployment.md`; create benchmark report and artifact verification scripts.

**Interfaces:** Consumes actual software statistics/display and codec manifest; produces explicit project/native setting, codec labels and deployment verification of MIME/hash/isolation.

- [ ] Write tests for software default H264, explicit native/SFU labels, capability failure, no silent fallback and missing deployment asset/header rejection.
- [ ] Run new tests; Expected: fail with existing UI/deployer.
- [ ] Implement controls/stats and self-hosted artifact verification, update one-click deployment and rollback docs for Caddy/header changes.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` and real 180 sec high motion/30 min bounded-memory/P2P/TURN/four-viewer tests. Expected: complete evidence or explicitly failed acceptance, never deploy unverified default.
- [ ] Commit, fresh whole-branch review, fix important findings with regression tests. Present exact acceptance state and any measured limits.
