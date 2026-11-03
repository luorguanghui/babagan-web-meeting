# SFU hardware H.264 and resolution protection

## Diagnosis

The user's Edge screenshot showed OpenH264, 640×360 at about 52 fps, a 4.84 Mbps encoder target, 5.76 Mbps congestion estimate, and `bandwidth` quality limitation. This establishes spatial downscaling; it does not establish a 60 fps capture source or a loss percentage from cumulative NACK counts.

The media publisher/codec/quality files are identical between the Nov 2 baseline `27eae1e` and the deployed web `5012ef1`. The Nov 3 security rollout changed the API and Worker control gateway, not the deployed frontend or browser-to-SFU media path. No evidence currently attributes the regression to that rollout; network conditions and negotiation still influence the result.

In the authorized Edge test meeting, the normal offer preferred H.264 High but the SFU answer selected constrained-baseline `42e01f`. On this RTX 4070 Ti, MediaCapabilities reported that profile as software and advertised High/Baseline profiles as power-efficient. Offering only those supported profiles negotiated High `64001f`. NVIDIA encoder sessions rose from zero to one while sharing and returned to zero when stopped. Synthetic capture did not expose `encoderImplementation` in stats, so no particular implementation string is claimed.

Keeping the original frame-priority policy still downscaled to 720p. Resolution priority restored 1920×1080, also decoded by an independent receiver. Six prototype samples retained 1080p with source 38–48 fps and encoded 39–49 fps; this test does not prove steady 60 fps under native display capture or every network condition.

## Change

- SFU H.264 defaults to hardware preference. Query actual advertised packetization-mode 1 profiles at the final scaled dimensions, with a one-second deadline. Advertise supported, power-efficient profiles and repair codecs, preferring High.
- Missing/failed/slow capability APIs or no hardware result retain the established compatible offer. A user-selectable compatibility mode restores it explicitly for older receivers. Hardware use remains a browser decision.
- Use the same aspect-preserving 1080-short-side scaling helper as P2P and protect resolution under congestion. Bandwidth shortage may reduce frame rate.
- Expose the negotiated H.264 profile alongside existing encoder statistics.
- Retain the selected mode through recovery; cancellation during probing cannot allocate or publish a stale session.

## Validation and rollout

Full web suite: 675 tests passed before the final cancellation test; final targeted codec/session/recovery/stats suite: 40 passed. TypeScript build, Vite production build, and changed-file ESLint passed. Independent review identified and verified the scaled capability-probe correction. No API, Worker, dependency or paid-service change is required.

Rollout is static web only. Existing Caddy routes send API/health to API and RTC to LiveKit independently of the web container. The purpose-built release therefore preserves active meetings, replaces only `web` with `--no-deps`, verifies all other container identities and configuration hashes, checks health and exact public artifact bytes, and retains immutable-image rollback. It does not run the generic updater's meeting-creation smoke or restart any media/signaling service. Browser acceptance must be repeated with native codec/parameter methods after rollout; prototype overrides have already been removed.

Deployment status and actual candidate validation are recorded separately in the release evidence; this document alone does not assert deployment success.
