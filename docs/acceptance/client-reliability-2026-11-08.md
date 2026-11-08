# Client reliability acceptance — 0.1.5 candidate

This record tracks the reported Windows protected-desktop interruption, Android viewport/roster layout, meeting entry priority, missing playback audio and missing update progress. Validation below distinguishes deployed fixes, local evidence and outstanding device acceptance.

**Publication split:** the first 0.1.5 release contains Android audio/permissions/insets, responsive UI and Android/Windows update progress only. The native UAC/capture changes described below remain in an unmerged research working tree. The first release retains the previously shipped native capture implementation and standalone installer0.2.2; it does not claim that desktop60fps or UAC end-to-end acceptance has passed.

**Published:** PR32 merged as `2b60c85`; the web and both0.1.5 clients (feed sequence6) are deployed and publicly verified. The release preserves the three-room API and media services. An initial web image contained an old same-size/epoch-mtime HTML file despite a correct build context; rollback succeeded. A one-variable timestamp rebuild produced the correct file. The retry uses a content-addressed COPY directory, nonzero content-derived file times and full image-artifact hashing before activation, followed by strict public checks. Android playback sound/echo and device insets still require the user's real-device acceptance.

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

This disproves treating the earlier synthetic-input loopback results as acceptance of real desktop capture. It does not yet prove whether the newly modified recovery behavior is responsible or whether the released helper has the same issue. The subsequent source-pinned comparison and updated testing authorization are recorded below. OBS was researched only and is now explicitly deferred at the user's request.

## Subsequent fixed-fixture diagnosis

The user subsequently authorized continued local tests without repeated scheduling questions and explicitly requested remaining on DXGI, without switching to OBS. Tests use an owned full-screen pattern and a local receiver; games and external meetings are excluded. The frozen v2 renderer SHA-256 is `42de1275aadafc83292bbe246e7d8deade373c6284fbb7556b2959ddb7c361e3`. Earlier tests with different renderers must not be used as a causal comparison.

The fixed late/early-selection pair both encountered `AcquireNextFrame` HRESULT `887A0026`, aligned to the same approximately five-second wall-clock phase across independent FFmpeg processes. Those runs do not establish an early-selection throughput improvement. A separate75-second hidden metadata listener spanning another capture reported no `WM_DISPLAYCHANGE` or `WM_SETTINGCHANGE`. This does not identify the responsible driver/process. WMI, DXGI and display-path enumeration show different render/display adapter identities; neither GameViewer nor a physical-monitor path is established as the cause. No remote-control process or display driver was disabled.

Input/output timestamp instrumentation established a separate selection loss. Irregular acquired samples at roughly76fps were reduced to roughly57–58fps by the existing floor-bucket expression. Pure FFmpeg regressions with distinct pixels showed phase-dependent loss even for a true60fps source on a144Hz timestamp grid. A bounded-deadline candidate preserves original selected pixels and PTS, retains30/60fps phase-jittered input, limits double-rate input, and does not accumulate a catch-up backlog after static/slow content. It does not create duplicate frames.

In the actual same-fixture bucket/deadline pair, continuous segments measured54.9–57.8fps versus59.2–60.0fps after selection, with exact agreement between observed timestamps and each expression. Both runs still had four access-loss interruptions, so this is evidence for fixing selection loss, **not stable end-to-end60fps acceptance**. The minimal production expression change retains the existing late filter position. FFmpeg9 and legacy6 each passed32 targeted tests; the native suite passed108 tests before subsequent source-proof work began.

## Real picker boundary

A separate fixture exercised the actual `captureNativeScreen` picker/sentinel path. Selecting the only active whole screen returned `displaySurface: monitor`, `deviceId: screen:4:0`, dimensions2510×1156 and60fps. The existing hardcoded `screen:0:0` check rejected it before native capture started. Both diagnostic attempts stopped their browser tracks and exited; no UAC prompt was triggered. An authenticated single-active-monitor source-proof compatibility change is being developed without bypassing user selection or revocation. UAC mute/unmute/ended behavior remains unverified.

An isolated same-source/same-toolchain FFmpeg baseline/recovery prototype is also being prepared. It must recreate invalid duplication resources, validate the source/format, retain monotonic timestamps and remain cancellable. Merely ignoring ACCESS_LOST or suppressing the browser sentinel is not an acceptable fix. Neither prototype nor the new native candidate has been published.

## 0.1.6 / standalone0.2.3 release boundary

The user requested publishing the current candidate for their own testing, while holding further UAC recovery work. This release includes the bounded-deadline selector, authenticated single-active-monitor source compatibility, the already-completed protected-desktop recovery logic, and the stale idle-desktop probe fix. Independent review reproduced and then verified the latter fix. Final targeted validation passed121 native tests and156 web tests, with native/web typechecks and touched-file lint passing. Experimental FFmpeg binaries, recovery patches, timer/Frida probes and diagnostic fixtures are excluded. The pinned Gyan9.0.2 dependency is unchanged, so compatible installed dependencies remain reusable.

After a user-side reboot, the observed desktop changed to2560×1440 at approximately320Hz. The old and candidate capture paths no longer reproduced periodic ACCESS_LOST in these runs. This does not identify which prior environmental component caused the five-second invalidations. No display/remote-control configuration was modified by this work.

Two separate60-second local tests used the real picker/sentinel, candidate native code, production P2P sender and hardware AV1 (`NVIDIA AV1 Encoder MFT`), output1920×1080 and a10Mbps ceiling. Excluding the first5seconds, ordinary movement averaged58.764 received fps, minimum53.006, with5/55 samples below55 (one near54.99). Fixed-seed chaotic movement averaged59.110 received/decoded fps, minimum53.008, with1/55 samples below55. Both completed without capture errors or restarts. These observations are not a claim of a strict55fps minimum, remote/SFU performance, or verified absence of compression artifacts.

A separate frame-ID marker experiment produced only invalid marker readings, so it supplies no unique-frame or duplicate-frame conclusion and is not included in the product. The earlier small decoded-region hash is likewise not proof of distinct full frames. Actual UAC prompt behavior remains unverified; no UAC prompt was launched during these tests. The user will perform release-device acceptance.
