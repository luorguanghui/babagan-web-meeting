# Current Meeting Discovery, Admin End, Codec Selection, and WebRTC Diagnostics

## Goal

Make the single active meeting discoverable from the create page, allow an administrator to end it with the global administrator password from either the create page or the meeting room, let a screen sharer choose Auto, H.264, or VP8, and expose read-only WebRTC statistics for diagnosing stalls and audio/video drift.

The implementation must not change the existing 1080p30/1080p60 capture profiles, the 10 Mbps motion bitrate, the playout delay, or the simulcast policy. Those variables stay fixed so codec and runtime statistics can be evaluated independently.

## Existing Constraints

- The domain allows at most one non-terminal meeting. `created`, `active`, and `grace` are non-terminal; `ended` and `expired` are terminal.
- The meeting slug is currently unguessable and shared through a direct link. This feature intentionally makes the current non-terminal meeting and its join link public on `/create`.
- The global administrator password is stored only as an Argon2 hash on the server.
- The existing host-session cookie grants full host controls. A one-time administrator-password end request must not create that cookie or grant any other host capability.
- Meeting passwords remain separate from the global administrator password.
- The supported client surface remains the project's existing Windows Chrome and Edge target.

## Public Current Meeting API

Add a public `GET /api/v1/meetings/current` endpoint with the general API rate limit. It returns an object with a nullable `meeting` field.

When a non-terminal meeting exists, the public meeting object contains only:

- `slug`
- `name`
- `status` (`created`, `active`, or `grace`)
- `joinUrl`
- `requiresPassword`
- `isFull`

It must not expose participant identities, participant names, password hashes, internal meeting IDs, share grants, host sessions, or audit data.

The service synchronizes the meeting lifecycle before returning it. If synchronization transitions the meeting to `ended` or `expired`, the endpoint returns `meeting: null`. If no non-terminal meeting exists, it also returns `meeting: null` with HTTP 200.

## Administrator-Password End API

Add `POST /api/v1/meetings/:slug/admin-end` with body `{ adminPassword: string }`.

The endpoint:

1. Uses the existing administrator-password rate-limit bucket: five attempts per IP per 15 minutes.
2. Verifies the supplied password against `ADMIN_PASSWORD_HASH` with the existing password hasher.
3. Returns the existing uniform `ADMIN_AUTH_FAILED` response for an invalid password.
4. Ends the meeting through `MeetingService.endMeeting`, ensuring sessions are revoked and the LiveKit room is closed.
5. Does not create or refresh a host-session cookie.
6. Records a `meeting_ended_by_admin_password` audit event.
7. Treats an already terminal meeting consistently with the existing meeting lifecycle errors.

The existing cookie-authenticated host `POST /api/v1/meetings/:slug/end` endpoint remains unchanged.

## Create Page Experience

The create page loads the current meeting on mount, when the document becomes visible again, and every 15 seconds while visible. Polling stops when the component unmounts.

When a current meeting exists, render one current-meeting card above the create form. The card shows:

- Meeting name
- Localized status: waiting for participants (`created`), in progress (`active`), or temporarily empty (`grace`)
- Whether a meeting password is required
- Whether the room is full
- A quick-join link to the existing meeting lobby
- An administrator-password field and an “End meeting” action

The quick-join link is disabled when `isFull` is true. It never contains a meeting password.

The administrator password is held only in component memory, cleared after every successful end request, and never written to local storage, session storage, the URL, logs, or an error message. A successful end refreshes the current-meeting query immediately and restores the normal create state. A failed query leaves the create form usable and offers a retry action.

After creating a meeting, the page updates the current-meeting card immediately from the creation response and a fresh summary request.

## Join Lobby Password Behavior

The meeting lobby loads the existing public meeting summary before join submission.

- If `requiresPassword` is false, the meeting-password field remains optional.
- If `requiresPassword` is true, the field is visibly marked required and an empty value is rejected client-side.
- Direct meeting links and create-page quick joins follow the same behavior.
- The server remains authoritative and performs the existing password verification.

No password is placed in navigation state, query parameters, storage, or the join URL.

## In-Room Administrator End Control

Add a compact administrator end form to the meeting side rail for participants who do not have an authenticated host session. It contains a password field and a destructive “End meeting” button.

Host authorization begins in an `unknown` state. The password form is rendered only after host-session authorization has failed, preventing a flash of duplicate controls for the real host. Authenticated hosts keep the existing HostMenu end button and do not see the password form.

On success, the participant follows the existing terminal-meeting flow and returns to `/create`. The password is cleared. On failure, an inline localized error is shown without revealing whether the meeting exists or whether another participant is the host.

## Screen-Share Codec Selection

Add a “Screen-share codec” select next to the screen quality control with three choices:

1. H.264 — default
2. Auto
3. VP8

The selection is in-memory meeting UI state and is not persisted. It is disabled while screen sharing is starting or active and becomes editable again after sharing stops.

Codec mapping at publication:

- H.264 passes `videoCodec: 'h264'` to the LiveKit screen-share video track publication.
- VP8 passes `videoCodec: 'vp8'`.
- Auto omits `videoCodec`, allowing LiveKit and the browser to use their default negotiation.

The change applies only to the screen-share video track. Screen-share audio remains Opus and shares the existing `screen-share` stream name. H.264 keeps LiveKit's VP8 compatibility fallback behavior. The 60fps profile remains 1920x1080, 60fps, 10 Mbps, `motion`, and `maintain-framerate`.

## Read-Only WebRTC Diagnostics

Add a collapsible “WebRTC statistics” panel that appears when a local or remote screen share is present. It is diagnostic only and never changes encoder settings automatically.

Sample once per second and show the latest values. Stop sampling when sharing ends, the room disconnects, or the component unmounts.

### Sender metrics

- Requested codec and negotiated codec/MIME type
- Resolution
- Frames per second
- Current video bitrate derived from byte deltas
- `framesEncoded` and `framesSent`
- `framesDroppedByEncoder`, when available
- Average encode time derived from `totalEncodeTime / framesEncoded`
- `qualityLimitationReason` and quality-limitation durations
- NACK, PLI, FIR, and retransmitted-byte counters when available
- Selected candidate-pair available outgoing bitrate, round-trip time, and packet loss when exposed

### Receiver metrics

- Negotiated codec/MIME type
- Resolution and decoded/rendered frames per second
- Current received video bitrate derived from byte deltas
- `framesDecoded`, `framesDropped`, `freezeCount`, and `totalFreezesDuration`
- Jitter
- Average jitter-buffer delay derived from `jitterBufferDelay / jitterBufferEmittedCount`
- NACK, PLI, FIR, and packet-loss counters when available
- Screen-share audio jitter and jitter-buffer delay when available

Unavailable browser fields display an em dash rather than zero. Counters are never interpreted as rates without comparing two samples. Sampling failures are contained inside the diagnostics panel and do not affect the meeting.

The room controller exposes normalized diagnostic snapshots rather than leaking LiveKit room or peer-connection internals into React components. The formatter and delta calculations are pure, separately tested functions.

## Localization and Layout

All new public labels, status values, validation errors, and diagnostic names are available in Simplified Chinese and English through the existing i18n catalog.

The current-meeting card follows the existing create-page panel style. The administrator end form is compact and stays in the side rail. The diagnostics panel uses a compact definition-list or table layout, collapses by default on narrow screens, and does not reduce the shared-screen stage size while collapsed.

## Error Handling

- Current-meeting lookup failure does not disable meeting creation; show a retryable inline message.
- A stale quick-join link follows the existing ended/expired meeting handling.
- Invalid administrator passwords use the existing uniform authentication error.
- Rate limiting uses the existing localized `RATE_LIMITED` handling.
- If ending the meeting closes the database state but LiveKit cleanup temporarily fails, the existing terminal media-cleanup retry remains authoritative.
- Unsupported explicit codec publication surfaces the existing screen-share start error and returns the share controller to idle. The user can then choose Auto or VP8 and retry.
- Diagnostics collection errors never stop media publication or playback.

## Testing

### Contracts

- Current-meeting response accepts a nullable public meeting and rejects sensitive or malformed fields.
- Administrator-end request accepts only a bounded non-empty password.
- Codec values accept only `auto`, `h264`, and `vp8`.

### API and services

- Current meeting returns the synchronized non-terminal meeting or null.
- Public current meeting does not expose sensitive fields.
- Correct administrator password ends the meeting, closes media, revokes sessions, and records an audit event.
- Incorrect administrator password is rejected without ending the meeting.
- Administrator end uses the administrator rate-limit bucket.
- Administrator end does not set a host cookie.

### Web

- Create page shows, refreshes, joins, and ends the current meeting.
- Create page remains usable after a current-meeting lookup failure.
- Protected meeting lobby requires a password; unprotected meeting does not.
- A non-host sees the administrator end form, while a host sees only HostMenu.
- Password fields are cleared and never written to browser storage.
- Codec selection defaults to H.264, locks during sharing, and publishes `h264`, omitted, or `vp8` correctly.
- Diagnostic delta calculations produce correct bitrate, FPS, encode-time, and jitter-buffer values.
- Diagnostic sampling starts and stops with the media lifecycle and tolerates missing statistics.

### Verification

- Run the complete test suite, typecheck, lint, and production build.
- Exercise create-page current-meeting polling and both end paths in a browser.
- Join a protected and an unprotected meeting through the public card.
- Publish a screen share once with each codec selection and confirm the negotiated MIME type in diagnostics.
- Confirm no administrator or meeting password appears in storage, URLs, console logs, or rendered errors.

## Non-Goals

- Supporting multiple simultaneous meetings
- Persisting codec preferences
- Raising the 60fps bitrate above 10 Mbps
- Changing simulcast, Dynacast, capture resolution, playout delay, or automatic quality adaptation
- Granting full host privileges after an administrator-password end request
- Server-side transcoding
- Long-term storage or upload of WebRTC diagnostic samples
