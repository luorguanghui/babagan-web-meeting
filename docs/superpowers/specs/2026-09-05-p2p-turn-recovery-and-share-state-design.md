# P2P TURN recovery and share-state consistency design

**Date:** 2026-09-05

**Status:** Approved in conversation; implementation pending written-plan review.

## Goal

Keep the browser, database, LiveKit room, and P2P signaling room consistent when a screen share ends, and make Cloudflare TURN availability real and diagnosable instead of silently presenting a coturn fallback as a successful Cloudflare selection.

## Observed failure

The production meeting reproduced this sequence:

1. The browser still displayed an active share and sent P2P offers.
2. The meeting row had `share_identity = NULL`, the participants endpoint reported no active sharer, and the LiveKit room had no `SCREEN_SHARE` track.
3. The signaling session therefore returned `P2P_FORBIDDEN` for every offer/ICE frame. SFU continued to work because it did not depend on the P2P signaling authorization gate.
4. The API returned HTTP 200 for an explicit Cloudflare ICE request, but the response was actually `turnProvider: coturn` because the Cloudflare credential request could not connect to `rtc.live.cloudflare.com:443` (`ETIMEDOUT` for IPv4 and `ENETUNREACH` for IPv6).
5. Coturn was listening, the Alibaba firewall and UFW rules exposed the required ports, and the browser gathered relay candidates from coturn. Coturn was not the first failing boundary in this reproduction.

## Design

### 1. Release the client-side share state from the authoritative webhook boundary

`meetings.share_identity` remains the authorization source for P2P offers. The system must not weaken the offer check when a client is stale.

When a LiveKit `track_unpublished` event for `SCREEN_SHARE` or `SCREEN_SHARE_AUDIO`, or a participant-left event, actually clears a matching `share_identity` row, the webhook handling path will emit one post-commit `share-gone` notification for that meeting. The notification will be sent through the existing `P2pRoomRegistry.broadcastShareGone` path so every connected browser tears down stale viewer/share controllers. Duplicate webhook delivery must not produce duplicate notifications: the existing `processed_webhooks` idempotency transaction gates the callback.

An event for an old identity that does not match the current database lock will not broadcast `share-gone`. This prevents an old LiveKit unpublish event from terminating a newer share. The route and host/participant release endpoints keep their existing notifications; the webhook callback covers the path that currently clears the database without notifying P2P clients.

The browser's existing `onShareGone` cleanup remains the single client cleanup path: it clears the viewer P2P controller, restores the LiveKit subscription, and stops any local screen-share controller that still believes it owns the share. Tests will assert both the changed database state and the single broadcast outcome.

### 2. Make Cloudflare TURN availability observable and configurable

The API will continue to return coturn as a safe fallback when Cloudflare is temporarily unavailable, but the fallback path will emit a redacted structured warning containing the provider, destination host, and network error class. It must never log the Cloudflare API token, generated TURN credentials, SDP, ICE candidates, or participant data.

The production fix for this environment is network-side: verify TCP 443 reachability from both the host and the API container to `rtc.live.cloudflare.com`, then populate `CLOUDFLARE_TURN_CONNECT_IPS` only with an IP that is proven reachable. The existing pinned-HTTPS implementation keeps `rtc.live.cloudflare.com` as TLS SNI and HTTP Host, so pinning does not change the Cloudflare virtual-host identity. If no valid reachable edge IP can be established, Cloudflare remains unavailable and the deployment must report that fact rather than claiming Cloudflare TURN is active.

The provider-specific client gate remains strict: a request for Cloudflare is accepted only when the response says `turnProvider: cloudflare`. A response that falls back to coturn must not be applied to a Cloudflare-specific offer.

### 3. Verification and operational evidence

The test suite will cover:

- webhook share release broadcasts exactly once after a matching `track_unpublished` or participant-left event;
- duplicate webhook delivery and stale-identity events do not broadcast;
- client cleanup after `share-gone` removes stale P2P/share state;
- Cloudflare request failures are logged without secrets and preserve the coturn fallback;
- a successful pinned Cloudflare request preserves SNI/Host behavior and returns Cloudflare ICE servers.

Production verification will use a newly created meeting after the stale meeting is gone. It will separately check the coturn ICE response, the Cloudflare-specific ICE response, P2P signaling offer/answer exchange, selected direct/relay candidates, and SFU fallback. The deployment record will preserve only redacted statuses, error classes, service health, and release provenance.

## Non-goals

- Do not bypass the P2P sharer authorization check.
- Do not expose Cloudflare API tokens or TURN credentials in logs, Git, browser output, or the design record.
- Do not change the LiveKit/SFU fallback architecture.
- Do not silently treat coturn credentials as Cloudflare credentials.
- Do not modify production firewall rules or secrets until a read-only connectivity probe identifies the exact missing network path.

## Files and boundaries

- `apps/api/src/livekit/webhook-handler.ts`: detect matching share-lock release and report the post-commit notification.
- `apps/api/src/http/routes/livekit-webhook.ts` and app wiring: connect the webhook outcome to `P2pRoomRegistry.broadcastShareGone`.
- `apps/api/src/http/routes/ice-servers.ts`: redacted Cloudflare fallback observability without changing the response contract.
- `apps/api/src/services/cloudflare-turn.ts`: preserve and test pinned HTTPS/SNI behavior.
- Existing webhook, signaling, ICE, and meeting-room tests: lock down the cross-component behavior before implementation.
- `infra/.env.production` on the target host: protected, non-Git Cloudflare connectivity configuration only after validation.

