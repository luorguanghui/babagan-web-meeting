# TURN encoding parity and readable H.264 profiles

The browser TURN path now shares Cloudflare SFU's hardware-first H.264 capability selection and resolution-first sender policy. Capability detection completes before the initial offer; because ICE decides direct versus relay afterward, the same preference also applies to direct P2P. The advanced control is now named “H.264 encoding preference” for all browser transports, with an explicit compatibility option. The user's project software encoder option is preserved.

TURN no longer applies the separate bandwidth-pressure downsampling or balanced degradation policy. It retains the aspect-preserving 1080-short-side scale and `maintain-resolution`, repairing failed parameter writes without rebuilding the connection. P2P's bounded direct-encoder recovery, ICE recovery, audio, independent viewers, and 40 Mbps total uplink budget remain intact. This aligns encoding policy; TURN still has separate per-viewer connections rather than the SFU's single upload.

Statistics now render negotiated profiles as localized names and levels, for example “高档次（High） · 级别 3.1” instead of `64001f`. Constraint-bit parsing distinguishes Baseline, Constrained Baseline, Main, High, Constrained High and Predictive High 4:4:4; Level 1b and unknown values are handled explicitly. Profile names do not claim hardware acceleration. Reference: [libwebrtc profile parser](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/h264_profile_level_id.cc).

Validation: 699 tests in 56 web suites; TypeScript checking, production build, full web-source ESLint and diff whitespace checks passed. Regression cases cover sustained TURN bandwidth pressure at 30/60 fps, direct/relay migration, hardware and compatibility selection through ICE rebuild, cancellation during a pending capability probe, and English/Chinese sender/receiver profile rendering. Independent review reported no blocking findings.

Deployment baseline: web `d390abe63b2f185ffb3f9179dc78e6ec54848146`, API `1567742db5d44eeb25ddd311871af12f956efaa4`. The reviewed static-only release workflow checks exact artifact hashes, unchanged API/media/container identities and configuration, read-only health checks, and immutable-image rollback.

## Production verification

At 2026-11-04 02:18 HKT, web commit `fcbfcade1f9aae60acd18fe21d09ad5f4c2a032d` was deployed and verified. The API remained on the baseline commit. API, Caddy, LiveKit and coturn retained their exact container and image IDs and remained healthy. No paid service or quota configuration changed.

Public entry `/assets/index-B36QEf01.js` matched the local artifact SHA-256 `c3938a31ba1f1369a648b5b223aa59f19ca9fa4b190abe51cf9a37ced1e3a56f`. Both health endpoints returned healthy states. Server verification also checked codec/WASM resources and isolation headers. The release and rollback are retained under `/opt/babagan-web-meeting/var/releases/update-20261103T181752Z-turn-sfu-encoding-prebuilt/`.

Code was pushed to `codex/turn-sfu-encoding-20261104`. Existing tabs use the old loaded JavaScript until refreshed; refresh between shares. Validation here consists of automated behavior/UI tests and deployment checks, not a new live multi-device TURN quality measurement.
