# P2P recovery investigation — 2026-09-07

## Confirmed defects

- A viewer initially using persisted SFU ignores the offer before remembering the sharer. An idle viewer controller exists after the ICE configuration fetch, but its `requestRetry()` has no sharer and silently does nothing. Switching to either auto or TURN sends no retry. Regression tests reproduced both failures.
- Signaling has no deadline for a WebSocket upgrade/server welcome. A connection that never receives welcome can remain stuck indefinitely.
- Exhausted automatic signaling reconnections cannot be restarted by a viewer transport selection. Explicit UI reconnect is now separate from automatic media retry, so automatic TURN recovery does not reset the bounded retry budget.

## Changes and validation

- Remember the offer sender even in SFU mode. Resolve a switch's retry target from the current LiveKit screen share, then the remembered offer/controller.
- Add a 10-second connection/welcome deadline and use the existing bounded exponential reconnect mechanism without depending on the failed socket's close event.
- Allow an explicit UI retry to reconnect signaling after automatic attempts stop.
- All 515 web tests passed across 24 files. ESLint and the production TypeScript/Vite build passed. Vite retained its existing large-chunk warning.
- Independent code review identified automatic retry-budget reset in the first implementation; the explicit UI-only method resolves it. Re-review found no further high-confidence issue.

## Production observation and deployment

- Baseline release: `89ecb82967417bd77c850c6ab78a0abb6229195f`.
- Directory: `/opt/babagan-web-meeting`.
- API, web, LiveKit, coturn and Caddy were healthy before the change.
- The local sharer gathered host, server-reflexive and relay ICE candidates and sent offers. No answer was observed from the other device. The other device remained in the LiveKit participant list after leaving the P2P roster. Rejoining announced it again and triggered another offer, still without an observed answer. This does not establish the remote device's exact failure point without receiver-side evidence.
- Web-only hotfix image: `babagan-meeting-web:p2p-recovery-20260907`.
- Compose overlay: `var/releases/p2p-recovery-20260907.override.yml`, used after the baseline release overlay. API/media services were not restarted.
- Verified public HTML references `assets/index-Bx49uiAv.js`, matching the local build.
- Baseline release metadata remains unchanged; this is an additional hotfix overlay, not a full release recorded by deploy.sh. Retain the overlay until a normal release includes these changes.
- To roll back Web, run the baseline Compose configuration with the baseline release overlay and `up -d --no-deps web`, omitting the hotfix overlay. The old image remains available.
- Receiver-side P2P/TURN end-to-end validation is pending at the time of this record.
