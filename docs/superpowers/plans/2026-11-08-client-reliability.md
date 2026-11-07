# Client reliability and mobile usability implementation plan

> Execute the independent native capture, playback audio and update-progress tasks with scoped implementers; root owns integration and responsive UI. Each task first reproduces its failure and adds a meaningful regression before its fix. Preserve the user's existing authorization to implement, merge and publish; do not repeat design-approval questions for these specified corrections.

**Goal:** Keep authorized Windows sharing alive through protected-desktop interruptions, make Android meeting/workspace UI usable, capture permitted Android playback audio, and show truthful update progress.

**Architecture:** Retain existing native helpers, WebRTC publication and React pages. Treat unavailable desktop capture as a cancellable paused session. Use Android window insets outside the WebView, official playback capture from the existing projection, and native byte-progress events consumed by shared UI.

**Tech stack:** TypeScript/React, Node/FFmpeg DXGI, Java Android API26–36, existing WebRTC144 SDK, Windows C#.

**Spec:** User's 2026-11-08 bug report and four supplied screenshots, plus explicit clarification that Android should share device playback from as many apps as the OS permits.

## Global constraints

- Preserve 1080p60, user-selected per-viewer bitrate ceiling/default10Mbps and existing meeting isolation.
- Never disable UAC, elevate to capture secure desktop, bypass Android audio capture policy or silently substitute microphone.
- Stop/revocation/meeting-left always wins over recovery. Preserve same authorized display and track identity.
- No physical-device/ADB work or game launches; user owns final device acceptance.
- Preserve the approved orange visual style and four-action mobile dock. Rename “一起在线” to “参会者”.
- Do not modify user dirty Desktop checkout or shared local main. Use existing isolated worktree/branch.
- Release signed same-identity clients and resources from Babagan, with original downloads retained and no reinstall of satisfied dependencies.

## Evidence before changes

- Windows capture-recovery.ts retries known access loss only; max8 attempts and20seconds cancels a still-authorized UAC interruption. capture.ts startup timeout can discard prior access-loss classification; running no-frame paths lack desktop-state checks.
- Android ScreenCaptureService creates only a video track and returns systemAudio:false; webpage android-capture also requests audio:false and discards audio tracks.
- MainActivity applies system insets as WebView padding; edge-to-edge Android35+ and CSS100dvh/fixed surfaces can still occupy system bars. Move available viewport bounds outside the WebView.
- Expanded roster close button is absolutely positioned over the count because the list heading does not reserve its space.
- ClientWorkspace renders join/create before open rooms; links repeat an ambiguous name and lack a prominent per-room button.
- UpdateManager reports states only, not bytes; shared client snapshot discards any progress and UI renders text only.

## Tasks

### 1. Windows capture recovery
- [ ] Reproduce access-loss exit, timeout after denial, prolonged secure desktop, static VFR silence and stop-during-recovery in native tests.
- [ ] Add read-only ordinary-desktop availability detection; pause safely without consuming arbitrary20s retry budget, revalidate display on resume.
- [ ] Preserve bounded errors for unsupported/unknown conditions, monotonic frame index/time and cancellation.
- [ ] Run native capture test suite/typecheck and review diagnostics. Do not claim actual UAC acceptance without hardware evidence.

### 2. Android viewport and responsive meeting UI
- [ ] Add insets policy tests: bars/cutout/IME, zero insets, PiP/fullscreen.
- [ ] Wrap normal WebView in a bounded viewport container; root overlays remain full-window. Reapply on transitions.
- [ ] Reproduce expanded roster count/close overlap; reserve close-button area and constrain mobile overlays.
- [ ] Reduce tablet header/logo proportions and use “参会者”; browser verify320/390/tablet/landscape and largefont/longtitles.

### 3. Open-meeting entry priority
- [ ] Test open-room section precedes invitation/create in DOM and each repeated-name room link has unique context.
- [ ] Render open meetings first with clear per-room title/status/button and stable shortidentifier; preserve unavailable/full guards and no autojoin.
- [ ] Verify three simultaneous rooms and empty/loading/error cases on phone.

### 4. Android device playback audio
- [ ] Pin SDK API evidence and tests for playback-only/no-mic configuration, permission fallback, exclusion of ownUID and cancellation/cleanup.
- [ ] Add optional user-controlled device-audio request; MainActivity requests RECORD_AUDIO only for this action, then existing screen consent.
- [ ] Reuse ScreenCapturerAndroid MediaProjection; official AudioPlaybackCapture feeds existing SDK's mutable PCM callback with internal microphone recording disabled.
- [ ] Negotiate audio track on local bridge and publish it through existing shared-audio pipeline; preserve video if audio unavailable with accurate reason.
- [ ] Test delayed audio/video arrival, permission revocation and SDK disposal; build/lint signed-release-compatible Android artifacts.

### 5. Update progress
- [ ] Test real bounded monotonic downloadedBytes/totalBytes and ignored stale events across defer/retry/stop.
- [ ] Native download emits throttled byte progress; shared snapshot validates optional progress, clears it on terminalstate.
- [ ] Reusable UI <progress> displays percentage/bytes during download, indeterminate verification/install; include workspace and meeting update entry.
- [ ] Test resumed UI and no automatic update during active meeting.

### 6. Integration/release
- [ ] Run applicable full Web/native/Android suites, typecheck, lint, production/native builds and independent review.
- [ ] Record screenshot comparison and limitations; increment native releaseversions consistently, sign with existing key.
- [ ] Commit/PR/main merge; immutable-source package and publish website/clients/dependencies using reviewed release helpers.
- [ ] Public verify signatures/hashes, feeds, UI bundle, health; preserve API/media services for static/native-only release.

## Review focus

1. Long UAC wait must not become permanent sharing stop, but user stop must immediately cancel.
2. New Android projection must not reuse consent twice or accidentally record microphone.
3. Stale audio/update callbacks after meeting navigation must not attach to a replacement session.
4. IME, display cutout, PiP and fullscreen transitions must not double-apply or omit safe viewport space.
5. Three rooms with duplicate/long names must have unambiguous bounded entry buttons and stable session isolation.

## Added user requirement: sample-video frame cadence

- User explicitly confirmed the problematic preset is **dynamic1080p60**, on both P2P and Cloudflare SFU with low overall CPU/GPU load.
- Authorized sample: `C:/Users/123/Desktop/Desktop 2026.11.08 - 01.57.08.01.mp4`; first probe: H.264High,2560×1440,119.99fps,27.48seconds,47Mbps. Do not infer distinct-content frame cadence from container metadata.
- [ ] Measure actual source changes/duplicate frames and repeatable local playback cadence.
- [ ] Compare native input, sender encoded frames, decoder frames and presentation for H264/VP8/AV1 using the sample. Do not label a codec cap as root cause without measured per-stage evidence.
- [ ] Preserve sample as external authorized input; do not commit it or upload it to production.
