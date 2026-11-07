# Babagan Android client

Android 8.0+ (API 26), targeting API 36. Version 0.1.2 opens `https://meet.babagan.cloud/client?clientVersion=0.1.2` by default; trusted meeting deep links keep their original URL. The app opens only the trusted meeting origin in its embedded WebView. AndroidX WebKit exposes the `BabaganAndroid` bridge only to that exact origin; native handlers additionally require the main frame. Meeting UI, cookies, microphone, viewing and existing network transports remain in the web application.

## Build

From the repository root in PowerShell 7:

```powershell
./scripts/setup-android-dev.ps1
./scripts/build-android-client.ps1
```

Tooling is installed under `%LOCALAPPDATA%/BabaganDevelopment`; scripts set process-local environment variables without altering the global PATH. Java 22 works with pinned Gradle 8.13 / Android Gradle Plugin 8.11.1. Dependencies are pinned in `app/build.gradle`. Add `-Emulator` to setup to install an API 35 Google APIs x86_64 image and the emulator. The setup does not modify Windows hypervisor or BIOS settings.

The build script also redirects generated outputs and test reports to `%LOCALAPPDATA%/BabaganDevelopment/android-build/app` to avoid Java test-worker issues with non-ASCII workspace paths. Read current test reports there; an old repository-local `app/build` directory may contain historical output from earlier attempts.

Debug builds include unit tests and Android lint by default. Release build:

```powershell
./scripts/build-android-client.ps1 -Configuration Release -SigningStore 'C:/private/Babagan.p12' -SigningAlias babagan -SigningPasswordFile 'C:/private/password.txt'
```

The signing password is passed to Android `apksigner` through its file option, never included in command arguments or source control. Release builds require the pinned public update key at `scripts/client-update-public-key.json`; a copy is bundled as an APK asset. Preserve the same Android signing key across updates, and increment both `versionCode` and `versionName` in `app/build.gradle`.

## Capture and privacy

`capture.start` first opens Android's MediaProjection chooser. A foreground service and persistent Stop notification own the approved session. Native WebRTC sends the video over an on-device peer connection, providing a normal `MediaStream` to the existing web publisher. Signaling for this local connection crosses the origin-scoped bridge; no local HTTP server or additional meeting identity is created.

Version 0.1.2 advertises `maxScreenFrameRate:60` and lets the user select 30 or 60 fps. Both choices preserve the same aspect-preserving 1920×1080 pixel envelope. The selected rate configures the native video source, capturer calls, RTP sender maximum, SDP hint and returned track settings. The sender keeps resolution rather than requesting a lower resolution to pursue 60 fps. Its existing 12 Mbps on-device bridge budget is unchanged; the separate web publisher retains the user's selected outgoing bitrate, including 10 Mbps.

Frame arrival remains source driven, and the app never duplicates frames to claim 60 fps. Returned frame-rate settings describe configuration, not measured achievement; device/codec load may still reduce actual delivered cadence. There is an extra local encode/decode step before the web publisher, so actual performance and background continuity need device validation. Older clients without the new capability remain limited to 30 fps in the web UI and capture requests. `client.info` continues to report `systemAudio:false`: microphone audio uses the normal webpage/WebView permission path, while Android internal playback audio is not included.

Session IDs must be UUIDs. Cancelled permission dialogs cannot start late capture. A new request waits until the previous Android chooser has returned. Leaving the meeting, revocation, Stop, page navigation or closing the app releases capture. Rotation resizes the same virtual display instead of reusing the one-shot projection permission.

The Activity uses `singleTask`. An external room link cannot replace a joined meeting or active capture; users leave the current room before opening another. A listener lease prevents another Activity instance from replacing or detaching the capture service's owner. Update decisions also inspect capture service resources, including capture teardown.

The webpage reports actual microphone changes using `microphone.state`. Only an enabled microphone with existing Android audio permission and a foreground meeting can start the microphone foreground service. It remains active when that meeting moves to the background and stops on mute, leave, navigation or app close. The host never requests microphone permission or starts recording solely because a room was joined.

Debug builds alone expose `capture.test` with the same arguments and response as `capture.start`; it generates moving 640×360 I420 test pixels at 15 fps without any screen capture or permission. Release builds reject this method. It exists to validate native→WebView media independently from MediaProjection.

## Updates

The client automatically checks `/downloads/clients/android/stable.json` on launch. It verifies the RSA/SHA-256 envelope with its bundled public key before trusting any fields. Product, platform, channel, protocol, sequence, exact server artifact path, size and SHA-256 are checked. Download redirects are refused. Android APK package name, version and signing certificate must also match the current installation; the version code must increase.

The small signed-feed check may run during a meeting. APK downloads use a cancellable generation: no APK request starts while busy, entering a meeting or capture closes the transfer and invalidates it, and a fresh attempt resumes when idle. Updates download to app-private storage. PackageInstaller work and its confirmation UI are likewise deferred while a meeting or screen share is active or the Activity is backgrounded. The bridge emits `update.state` events for checking, deferred, downloading, downloaded, installing and errors. Android's install permission/confirmation remains visible when required. The first release checks as current, so validating an actual update requires a separately signed higher-version APK and feed.

No tests in this project capture the Windows desktop or launch games. Device tests should use only the app's synthetic source or explicitly designated content inside an owned emulator.

## Current validation

The dated record in `validation/2026-11-07.json` describes the earlier release checks. The 0.1.2 workspace/frame-rate change passed the Debug build, 28 JVM tests, Android lint, 40 focused web tests and web type checking. Its release package is built and signed separately after the source commit. Device media and update installation have **not** been validated: this host has no usable emulator acceleration, and bounded software-emulation attempts terminated with native access-violation crashes before Android boot. Build results do not establish successful screen sharing or sustained frame rate; those require the user's device and receiver statistics.

On an available owned emulator, install the debug APK and launch the generated-content harness:

```powershell
adb -s emulator-5580 install -r artifacts/android/Babagan-debug.apk
adb -s emulator-5580 shell am start -n cloud.babagan.meeting/.MainActivity --ez bridge-test true
adb -s emulator-5580 logcat -d -s BabaganTest:I
```

The harness emits a `BABAGAN_TEST` JSON record with decoded/displayed frames and connection state. Add `--ez projection-test true` to test actual MediaProjection, then choose only the owned emulator's designated test display/app in Android's chooser. It stops capture after 15 seconds and reports Stop handling. A stopped or unavailable emulator must never be recorded as a passing media test.
