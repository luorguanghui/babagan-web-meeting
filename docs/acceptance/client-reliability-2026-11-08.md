# Client reliability acceptance — 0.1.5 candidate

This change fixes the reported Windows protected-desktop interruption, Android viewport/roster layout, meeting entry priority, missing playback audio and missing update progress. Validation below distinguishes automated/local evidence from device acceptance.

**Publication split:** the first 0.1.5 release contains Android audio/permissions/insets, responsive UI and Android/Windows update progress only. The native UAC/capture changes described below remain in an unmerged research working tree. The first release retains the previously shipped native capture implementation and standalone installer0.2.2; it does not claim that desktop60fps or UAC end-to-end acceptance has passed.

## Capture interruption

DXGI desktop duplication is expected to lose access during UAC secure-desktop switches. The old helper only classified certain stderr patterns at process exit and spent its 20-second/eight-attempt recovery allowance while waiting for the secure desktop. It also missed `0x`-prefixed HRESULTs. The replacement pauses only when an ordinary-desktop metadata probe confirms unavailability, keeps the authorized frame transport, and retries after return. Expiry and delayed restart both recheck availability; cancellation and a successful frame invalidate stale probes. Unknown errors and ordinary desktop failures remain bounded.

The helper does not disable UAC, change desktops, acquire elevated capture privileges or resume a revoked browser sentinel. An already-started share can wait through an extended protected-desktop interval; before the very first native frame the web client's existing 15-second startup timeout still applies. Actual UAC/browser-sentinel behavior requires a real-machine check and is not implied by subprocess tests.

Native regression: 101 tests passed with installed FFmpeg9.0.2 and legacy6.0, including protected-desktop transitions, delayed starts, timeout races, static VFR content, ownership and abort.

## Android audio and permissions

API29+ playback capture uses the same MediaProjection instance as video and captures permitted MEDIA/GAME/UNKNOWN usage. The builder excludes Babagan's own UID, and the SDK's internal microphone recording is disabled before its PeerConnectionFactory is created. Playback PCM and meeting microphone remain separate. Native acknowledgement of own-application exclusion is required before the receiver's private audio registry marks a track safe; ordinary browser audio checks are not weakened.

Audio failure ends only the shared audio track and reports a fallback; video can continue. The actual native bridge now accepts the audio-ended event. Runtime permission requests are serialized, RECORD_AUDIO requesters coalesce, and the projection confirmation owns its dialog phase. Explicit audio denial permits video-only sharing; cancelled/empty callbacks and stale owners cannot start projection.

Audio source policy still applies: DRM, protected apps, phone/VoIP calls and cross-profile media are not promised. The UID exclusion policy and audible echo/sync must be checked on a device; tests do not claim those observations.

Android: 79 JVM tests passed; lint0errors with8existing warnings. The fixed installed WebRTC144 API was inspected and compiled. Windows updater:48 checks passed. No phone/ADB operations were performed.

## Viewport, room entry and updates

- System bars, cutout and keyboard insets now bound the normal WebView's native parent. The web page's viewport excludes those areas; fullscreen and PiP keep their full-window overlays.
- Expanded mobile roster headings reserve space for the close button. Measured count/close rectangles no longer intersect at390px width. Tablet header measured71.5px with34px logo and22px title at1200×800.
- Existing meetings precede invitation/create in both reading and visual order, with title, short identifier and a dedicated room-specific button. Full/unavailable rooms remain disabled. Three meetings fit in the checked390×844 initial viewport even while showing progress.
- Native update events carry real byte counts and revision numbers. The UI shows percent/MB during download and indeterminate verification/install phases. Deferred/closed/replaced transfers cannot publish stale progress or ready state. Legacy clients without byte fields show an indeterminate bar.

Automated final application suite:116files/1386tests passed, including both native FFmpeg variants. An existing jsdom unimplemented HTMLMediaElement.play diagnostic is emitted by a test environment; there are no failing tests. Typecheck/lint/build are verified separately at the final release commit.

## FPS investigation boundary

The user-supplied27.48second recording is encoded as2560×1440 H.264 at about120fps. In the3–23second motion interval,2400 decoded recording frames contain approximately600 meaningful image changes (about30/s), with small repeated-frame differences caused by compression. Container frame rate alone therefore does not establish60 distinct source images/s.

A file/synthetic-input local diagnostic reused production FFmpeg filtering, Y4M clock, HTTP frame transport, native pacer and codec/bitrate configuration. In Chrome157, H264/VP8/AV1 input/encoded/sent/received/decoded medians were approximately60fps at1080p and10Mbps. A corrected single AV1 run also measured60fps presentation. These results are **not** a real DXGI capture, production sender-controller, Edge/WebView2 or remote SFU/network acceptance. Additional exact-runtime/capture testing is recorded separately; do not use these narrower tests as proof of that full path.

The supplied recording stays outside the repository and is not uploaded with any release. No bitrate ceiling was raised, no frame duplication workaround introduced and no resolution reduction used.

## Subsequent real-capture check — release remains blocked

After explicit permission to occupy the local display, an owned full-screen test pattern was visually confirmed before clicking Start. The test used actual FFmpeg ddagrab, the native frame server/pacer, `createScreenShareController`, `createP2pShareController`, and WebView2 157.0.4341.42 with the Windows client's media flags. Grant/signaling and the receiver stayed in the same local test process; no external meeting or SFU participated. The browser capture picker/sentinel was not part of this fixture.

The H264 candidate run did **not** pass: the helper reported four capture-access-loss recovery attempts and delivered only147 native frames over approximately20 seconds. The output was2344×1080 because the observed display is ultrawide; receiver/encoder counters also deteriorated. The recorded result has `stopped:true`; helper activity became false and the owned window exited normally. No pixel recording was saved.

This disproves treating the earlier synthetic-input loopback results as acceptance of real desktop capture. It does not yet prove whether the newly modified recovery behavior is responsible or whether the released helper has the same issue. A source-pinned63e2a90 helper and sanitized HRESULT/tag observer are being prepared for a controlled comparison. Further capture requires a newly arranged test-display interval. OBS's DXGI/WGC recovery paths are being evaluated as an alternative, not yet integrated.
