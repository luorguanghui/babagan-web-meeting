# Task 10 report: controlled screen sharing and host actions

## Implementation

- Extended the Task 7 `HostApplicationService` rather than creating a duplicate host service. Share grants retain the optimistic meeting lock and LiveKit-first ordering, and now audit successful grants/revokes, failed LiveKit grants (`system_error`), participant releases, and host-ended meetings.
- Added a participant-authenticated `DELETE /api/v1/meetings/:slug/share` release path. Only the matching sharer can clear the lock; LiveKit is downgraded to microphone-only before database clearance. The existing host-only revoke remains independently API-authorized.
- Added `GET /api/v1/meetings/:slug/host-session` as a cookie-scoped authorization probe. The host menu renders no management controls until this request succeeds; grant/revoke, kick, and confirmed end actions continue to use host-authorized APIs.
- Added a browser screen-share controller with exact 1920×1080 30 fps/8 Mbps and 60 fps/15 Mbps profiles. Server grant or participant entitlement verification completes before `getDisplayMedia`, which requests computer audio and inspects returned audio tracks.
- Added native-stream LiveKit publication using `screen_share` and `screen_share_audio`, with matching frame-rate/bitrate options and rollback of partially published tracks. Server-pushed LiveKit permission changes enable an already-granted ordinary participant without trusting URL state.
- Added browser-ended cleanup that clears UI/stage state immediately and attempts both LiveKit release and participant grant release even when the HTTP call fails. Missing system audio shows Chrome/Edge source-specific guidance.
- Added an aspect-preserving shared-screen stage (`object-fit: contain`), screen quality controls, unique-grant host participant controls, and a responsive projection-surface meeting layout consistent with the existing teal/slate visual system.

## TDD evidence

- **API RED:** the new host service suite recorded five expected failures for missing share audits, system-error audit, participant release, and end audit. Minimal service changes made all eight host scenarios green.
- **HTTP RED:** host authorization and participant release API tests returned 404 before the scoped routes were added; both then returned the required 204/401 behavior.
- **Web RED:** the screen suite first failed on missing capture/stage/menu modules, then on the absent LiveKit publisher, integrated room authorization flow, server-pushed permission state, and pending-grant host-menu state. Each behavior was implemented after its observed failure.
- Tests cover unauthorized button state, both exact capture profiles, rejected server grants, missing computer audio, browser-ended cleanup with failed HTTP release, contain rendering, API-authorized host controls, unique grant state, LiveKit source publication, and integrated room UI ordering.

## Verification

Focused verification:

```text
pnpm --filter @meeting/api test -- host-service.test.ts api.test.ts
# 2 files, 29 tests passed

pnpm --filter @meeting/web test -- screen-share.test.tsx room.test.tsx
# 2 files, 34 tests passed (before the final host-menu test refinement)

pnpm --filter @meeting/web test -- screen-share.test.tsx
# 1 file, 12 tests passed after the final refinement
```

Fresh full verification before commit:

```text
pnpm lint       # exit 0
pnpm test       # 14 files, 167 tests passed
pnpm typecheck  # all workspaces exit 0
pnpm build      # API and web builds exit 0
```

## Scope

- No deployment, token-reconnect state machine, or Task 11 error/retry work was added.
- The backend service filename remains `host-application-service.ts` because Task 7 intentionally front-loaded that service; Task 10 only extends the behaviors needed for capture cleanup and auditing.

## Commit

`feat: add controlled screen sharing and host actions` (created after this report was written).

## Review fix round 1

- **RED — remote stage:** Added controller and room-page regressions proving a subscribed remote `screen_share` video enters `MeetingRoomState` and renders for a non-sharer. Both failed because only remote audio subscriptions were represented. The controller now constructs a screen stream from the subscribed video track, records sharer identity/name, clears it on unsubscription/room release, and leaves screen-share audio on the existing autoplay path.
- **RED — pre-publish departures:** Added leave, kick, and true `participant_left` webhook regressions where a grant exists but no screen track was ever published. All retained `share_identity`. Normal leave and kick now clear only a matching grant while revoking the participant session; the webhook independently clears a matching grant on disconnect.
- **RED — publication race:** Held LiveKit publication pending, ended the browser video track, then completed publication. The UI stayed in `starting` because the listener was registered after publication. The controller now owns the stream and registers `ended` before scheduling publication; stop waits for the in-flight publish, releases any resulting publication and server grant, and never transitions to `sharing`.
- **RED — host menu synchronization:** Rerendered the same participant from `isSharing: true` to `false`; the menu preserved stale local ownership and blocked a new grant. It now synchronizes to semantic external sharing identity changes while retaining immediate local feedback after a successful grant.

Focused verification after the fixes:

```text
pnpm --filter @meeting/web test -- screen-share.test.tsx
# 1 file, 16 tests passed

pnpm --filter @meeting/api test -- meeting-service.test.ts host-service.test.ts livekit.test.ts
# 3 files, 44 tests passed

pnpm typecheck
# all workspaces exit 0
```

Fresh full verification before the review-fix commit:

```text
pnpm lint       # exit 0
pnpm test       # 14 files, 174 tests passed
pnpm typecheck  # all workspaces exit 0
pnpm build      # API and web builds exit 0
```

## Review fix round 2

- **RED — leave removal failure:** Added a regression that fails the first media removal after the participant session is revoked. The matching share lock now remains held after that failure, and a repeated leave retries removal before clearing the lock.
- **RED — kick removal failure:** Added a regression that fails the first host kick removal, verifies the session was already revoked while the share lock remains held, then retries the kick. Host removal now recovers the persisted (revoked) participant session, attempts LiveKit removal again, and clears the matching lock only after success.
- Added an explicit repository lookup for participant sessions including revoked rows. It is used only to preserve the media-cleanup retry path; normal active authorization continues to use the time- and revocation-filtered lookup.

Focused verification after the fixes:

```text
pnpm --filter @meeting/api test -- meeting-service.test.ts host-service.test.ts
# 2 files, 26 tests passed

pnpm typecheck
# all workspaces exit 0
```

Fresh full verification before the round-2 commit:

```text
pnpm lint       # exit 0
pnpm test       # 14 files, 176 tests passed
pnpm typecheck  # all workspaces exit 0
pnpm build      # API and web builds exit 0
```
