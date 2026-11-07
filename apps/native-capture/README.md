# Windows native screen capture

This local helper supplies I420 video frames to the existing meeting page. The page continues to own screen-share permission, system audio, WebRTC encoding, P2P, TURN and SFU transport. Native mode currently requires Windows and **exactly one active display**; it refuses ambiguous display layouts instead of guessing which desktop the browser selected.

Requirements: Node 24, the repository's pnpm dependencies, Microsoft Edge, and an FFmpeg build whose `-hide_banner -h filter=ddagrab` output lists the boolean `dup_frames` option. Merely having `ddagrab` is insufficient: older builds can repeat the previous desktop frame internally without providing an opt-out. The CLI inspects this feature before reporting readiness and rejects incompatible builds with an actionable `--ffmpeg`/`BABAGAN_FFMPEG` error. PowerShell 7 is required only for the convenience launcher. A compatible portable FFmpeg can be selected without replacing any system installation.

```powershell
pnpm install
pnpm --filter @meeting/native-capture build
pwsh -File scripts/start-native-meeting.ps1 -Ffmpeg 'C:/Tools/ffmpeg/bin/ffmpeg.exe'
```

The launcher starts a hidden helper and an independent Edge profile under `%LOCALAPPDATA%/Babagan/MeetingEdge`. `--enable-features=WebRtcAV1HWEncode` enables Edge's advertised hardware AV1 path; the two Media Foundation H.264 software bitrate-control features remain disabled for H.264 fallback. `--disable-background-timer-throttling` and `--disable-renderer-backgrounding` keep the meeting frame-pacing timers active when that profile's tab or window is in the background, matching the verified runtime. These switches affect encoding and performance scheduling; they do not change browser security, capture permission, the normal Edge profile, or the default browser. Restart the dedicated meeting Edge profile after changing launch switches so its process receives the updated arguments.

Native-launcher rooms initially select Auto codec. For an actual native capture track, Auto plus the hardware preference queries the browser's advertised AV1 and packetization-mode-1 H.264 encoders at the scaled capture size, selected frame rate and bitrate. A supported, power-efficient AV1 encoder is preferred, followed by supported hardware H.264 High/Baseline/Main and repair codecs. An absent, failed or timed-out capability query retains normal Auto negotiation; explicit H.264/VP8 and ordinary browser captures retain their existing behavior. The peer can negotiate H.264 fallback, so AV1 preference is not an AV1 guarantee. L1T1 is requested only when the negotiated sender parameters unambiguously identify AV1.

New native P2P/TURN and Cloudflare sessions add startup and maximum bitrate hints to their local offer and remote answer, bounded by the current per-viewer share or SFU cap. No minimum bitrate is imposed. These hints prevent the browser's initial probe ceiling from staying below the selected cap; congestion control and RTP sender budgets still apply. Mid-session budget rebalancing continues through sender parameters; connection setup hints are refreshed with the next connection.

On first use, allow Edge's local-network permission for the meeting origin, then explicitly share the single display in the meeting UI. Closing the share or its connection stops the owned FFmpeg process. An idle helper exits after 30 minutes, leaving time to join a meeting before starting a share.

`scripts/start-native-meeting.cmd` is a double-clickable entry point and accepts the same arguments as the PowerShell script. It finds PowerShell 7 on PATH or at `%USERPROFILE%/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`; it does not bypass execution policy. Supply `-Ffmpeg` or configure `BABAGAN_FFMPEG`/PATH before a no-argument launch. The PowerShell launcher waits up to 15 seconds for a token-free status file and reports readiness only after FFmpeg validation, Edge validation/launch (unless `-NoOpen`), and loopback startup. Startup failures produce a readable diagnostic. Timeout cleanup terminates only that launch attempt and its descendants, and the temporary status file is removed. `-StartupTimeoutSeconds` and `-IdleTimeoutMs` provide bounded troubleshooting overrides.

Foreground operation and diagnostics:

```powershell
pnpm --filter @meeting/native-capture start --ffmpeg 'C:/Tools/ffmpeg/bin/ffmpeg.exe'
pnpm --filter @meeting/native-capture start --help
```

For source development, use `pnpm --filter @meeting/native-capture dev:native`. The package deliberately has no `dev` script, so the repository's general `pnpm dev` command does not open the native Windows helper or its Edge window.

FFmpeg resolution order is `--ffmpeg`, `BABAGAN_FFMPEG`, then `ffmpeg` on PATH. `--edge` selects an installed Edge executable. `--origin` supplies an exact HTTPS origin, or a localhost HTTP origin for development. `--no-open` starts the helper without opening Edge. The capability URL is deliberately never printed; programmatic integration uses the server factory's returned `launchUrl`.

## Server factory and protocols

```ts
import { createNativeCaptureServer } from './dist/server.js';

const helper = await createNativeCaptureServer({
  ffmpeg: 'C:/Tools/ffmpeg/bin/ffmpeg.exe',
  origin: 'https://meet.babagan.cloud'
});
// helper: { port, token, origin, launchUrl, closed, close }
// await helper.close(); // terminate only this helper's capture and connections
```

The service binds a random port on `127.0.0.1` only. The launcher passes the capability in `/#nativeCapture=1.<port>.<token>`, keeping it out of URL requests and referrers. There is no wildcard CORS or unauthenticated capture route.

The browser uses `POST /frames-http` with the exact configured `Origin`, `Authorization: Bearer <token>`, `Content-Type: application/json`, and body `{"frameRate":60}` (or 30). Preflight permits only POST and the two required headers for the exact origin; it never permits credentials or a wildcard origin. The response is `application/octet-stream`: a four-byte big-endian metadata length (maximum 4096), that many UTF-8 JSON bytes containing `NativeCaptureFormat`, then fixed-size packets containing the shared 16-byte header plus I420 pixels. No control JSON is inserted into the binary body. A fetch BYOB reader can fill each packet buffer directly. Aborting the fetch or cancelling its reader stops the owned capture.

Before binary output starts, HTTP failures return a small JSON error with status 403 for authorization, 409 for capture ownership, 422 for unsupported display mapping, or 502 for other capture startup failures. Invalid JSON, oversized request bodies and unsupported content types return 400, 413 and 415 respectively. Once binary output has started, a capture failure closes the stream instead of mixing JSON with pixels.

WebSocket `/frames` remains available for diagnostics and compatible clients. It requires the exact configured `Origin` and both subprotocols `babagan-native-v1` and `auth.<32-byte-base64url-token>`. The accepted protocol is only `babagan-native-v1`. The production browser does not silently fall back to WebSocket when HTTP fails, because the measured Edge raw-WebSocket receive path could not sustain the target frame rate.

An authenticated WebSocket connection must send `{"type":"start","frameRate":60}` or frame rate 30. Only one HTTP or WebSocket connection can own capture at a time. `{"type":"stop"}`, disconnect, malformed native output, startup timeout, or helper shutdown stops the owned process. JSON controls and HTTP request bodies are limited to 1024 bytes; invalid controls receive an error without crashing the service. Format, binary packets, statistics and errors follow `packages/contracts/src/native-capture.ts`. Statistics are sent only on the owning WebSocket; the HTTP byte stream contains only format metadata and video packets.

`capturedFrames` counts validated acquired samples selected from FFmpeg input, capped to the target cadence. `sentFrames` counts completed socket writes; it does not claim the remote peer displayed them. `droppedFrames` counts transport backpressure, disconnect and failed-write drops. Optional `contentChangedFrames` counts full-I420 pixel transitions across those captured samples, including the first sample and candidates subsequently dropped by transport. It compares each sample with its immediate predecessor, so A→B→A is three changes, not two globally distinct images. A synthetic source that actually supplies 120 identical samples over two seconds reports 120 captured/sent samples and one content change. A stationary DXGI desktop may supply fewer samples. Identical pixels are never evidence of 60fps motion; source and receiver distinct-content rates must still be measured for moving-content acceptance.

## Capture behavior

DXGI capture requests up to twice the target frame rate with **`dup_frames=0`**, explicitly disabling ddagrab's internal last-frame duplication. It converts acquired frames to limited-range BT.709 I420 and scales down only as needed to a maximum short edge of 1080 pixels and the shared pixel limit. It preserves aspect ratio and even dimensions. Time-bin selection admits at most one acquired input sample per target interval. There is no `mpdecimate`, `fps` or CFR conversion, and no timer injects repeats of a previous buffer. If the desktop stops producing acquired frames, output cadence decreases; the helper cannot invent idle samples. Full-buffer equality is used only for the separate content-change counter, not to discard an acquired frame solely because its converted pixels match.

The synthetic source can supply a continuous sample cadence even with static pixels. Preserving those supplied samples kept the AV1 bitrate controller calibrated and reduced its static-to-motion send queue compared with intentionally dropping them to one sample per second. This diagnostic does not establish that a stationary DXGI desktop supplies the same cadence. With ddagrab duplication disabled, real desktop idle-to-motion behavior remains unverified after the restriction to synthetic/browser-tab-only tests. The helper intentionally accepts reduced idle cadence rather than synthesizing samples. Hardware H.264 fallback and receiver/network transients also require separate verification.

The parser copies streaming chunks directly into bounded frame buffers, validates Y4M headers and dimensions, and pairs pixels with `showinfo` PTS by frame index. Integer PTS/time-base values preserve precision in long meetings. The first pair anchors the epoch; subsequent timestamps use PTS, avoiding accumulation of delivery jitter. Synchronization queues hold at most eight unmatched frames, and socket buffering is bounded to two frame payloads. The helper stops on malformed or unsynchronized output rather than guessing a new boundary.

## Verification

```powershell
pnpm --filter @meeting/native-capture test
pnpm --filter @meeting/native-capture typecheck
$env:BABAGAN_TEST_FFMPEG = 'C:/Tools/ffmpeg/bin/ffmpeg.exe'
pnpm --filter @meeting/native-capture test
```

Use a feature-compatible executable for the complete optional suite above; positive CLI/launcher checks validate `dup_frames`. For a legacy-build rejection check, set `BABAGAN_TEST_LEGACY_FFMPEG` to an older executable separately. Synthetic filter-only tests can still use older FFmpeg because their controlled Y4M input replaces ddagrab and never captures the desktop.

The optional FFmpeg tests use synthetic pixels, never the desktop. They verify 60 selected samples with 60 unique images from 120 paired inputs, 120 selected samples with one content change across two static seconds, no above-target burst after a static-to-motion transition, finite-input sample counts, and preservation of border changes on selected samples. Other tests use real local WebSockets and owned fixture subprocesses for authorization, packet layout, explicit start/stop, cleanup, startup deadlines, source validation, timestamp drift, bounded parsing, content-change accounting, and backpressure. Live performance depends on the display refresh rate, capture/encode capacity and WebRTC path; a target setting alone is not evidence of 60 distinct receiver frames per second.

For transport diagnosis without sharing any screen:

```powershell
node apps/native-capture/diagnostics/synthetic-transport.mjs 'C:/Tools/ffmpeg/bin/ffmpeg.exe'
```

This diagnostic uses only FFmpeg `testsrc2` pixels. It separately measures unpaced Y4M pipe parsing, real-time 60fps parsing with PTS, and the same source through the real helper WebSocket to a Node client. The recorded local run in `diagnostics/synthetic-results-20261107.jsonl` measured 384fps raw parsing and 59.53fps steady Node WebSocket reception at 1920×1080. These isolate transport capacity; they do not establish browser decoding, WebRTC or remote receiver performance.

The separate `diagnostics/synthetic-http-browser.mjs` prototype uses a blank Edge test page and a separate helper process, also with generated pixels only. Its recorded result was 596/600 packets received at 59.57fps with a two-frame output bound. It demonstrated the HTTP/BYOB transport choice; production-browser, encoding and receiver checks are separate stages.
