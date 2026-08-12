# WebRTC Path and Quality Recovery Implementation Plan

1. Add failing screen-share/profile tests for the 1080p30 resolution-first default and 720p30 flow profile.
2. Add failing sender tests proving the sum of all per-viewer `maxBitrate` values never exceeds the selected P2P budget and that unknown/direct/relay paths receive no multiplier.
3. Implement session-wide bitrate rebalancing and remove direct-path boosting.
4. Add failing codec tests containing H264, VP8, RTX, RED and ULPFEC capabilities; implement stable preference ordering that preserves every capability.
5. Add failing viewer-controller tests for relay-to-direct and direct-to-relay selected-pair migration; implement continuous state correction.
6. Extend health stats and add failing sustained-loss/freeze hysteresis tests; implement per-viewer SFU fallback without penalizing healthy sessions.
7. Add failing page/signaling tests for offer/candidate arrival before ICE configuration and temporary WebSocket disconnect; implement ordered bounded queuing and serial replay.
8. Add a reconnect test that proves a negotiating sharer session creates a fresh peer connection/ICE generation; implement replacement and credential refresh.
9. Run focused tests after each change, then the complete test, typecheck and build suites.
10. Perform an independent code review against the design, resolve findings, commit and push.
11. Confirm no active meetings, back up the server, update the checked-out release, rebuild/recreate only the existing affected services, and verify HTTP/API health, WebSocket signaling, TURN availability and container stability.
