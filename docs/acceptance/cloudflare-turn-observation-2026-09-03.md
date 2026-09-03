# Cloudflare TURN observation acceptance — 2026-09-03

## Decision

**Pending manual observation.** The real-provider loopback feasibility gate is
recorded in [the loopback report](./cloudflare-turn-loop-probe-2026-09-03.md),
but this run did not have an authenticated live meeting with an active
Cloudflare screen share. The production controller therefore remains in
`observe` mode.

## Why the observation gate is pending

The available Edge session had no authenticated meeting tab at the time of
the code verification, and no new external meeting was created as part of
this continuation. Without a real sharer/viewer session, there is no honest
evidence for media FPS, output resolution, dynamic transport cap, or cleanup
after stopping a share.

## Required manual evidence

Run one Cloudflare TURN screen share in current Chrome or Edge and record only
sanitized values:

- selected provider and relay protocol;
- probe status and three stable capacity results, with median dispersion;
- fixed profile target and observed dynamic transport cap;
- actual outgoing bitrate, encoder target, FPS, output resolution, and scale;
- sender parameter writes in observation mode (the probe must not change them);
- closed state for both probe connections, both DataChannels, timers, and TURN
  allocations after the share stops.

Do not record ICE credentials, participant identities, candidate addresses, SDP,
screen content, or cookies. Control mode may be enabled only after these
checks pass; until then a probe error must leave the TURN media connection and
the selected profile untouched.

