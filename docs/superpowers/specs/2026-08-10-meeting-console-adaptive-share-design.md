# Meeting Console and Adaptive Screen Share Design

## Goal

Turn the meeting room into one coherent presentation workspace and replace the separate 1080p30/1080p60 modes with a stable adaptive 1080p share that prefers clarity, can settle at 30 fps, and uses 720p as its only resolution fallback.

The user has explicitly delegated product choices and requested uninterrupted execution. This specification records the chosen design and serves as the approved implementation baseline.

## Chosen media strategy

The existing two-profile selector is removed. Screen sharing always starts with one adaptive profile:

- capture target: 1920×1080, up to 60 fps;
- content hint: `detail`;
- degradation preference: `maintain-resolution`;
- selectable high-layer bitrate ceiling: 10, 13, or 15 Mbps, default 10 Mbps;
- selectable codec remains Auto, H.264, or VP8, default H.264;
- no server-side encoding or transcoding.

The publisher explicitly enables two simulcast layers rather than relying on LiveKit defaults:

- high: source resolution up to 1920×1080 and up to 60 fps, using the selected bitrate ceiling;
- fallback: 1280×720 at up to 30 fps and 3.5 Mbps.

There is no 960×540 layer. A receiver may move between 1080p and 720p, but cannot be assigned the previous 540p fallback. `maintain-resolution` tells the browser to reduce frame rate before spatial resolution when encoder or path capacity is constrained. The 720p layer's 30 fps limit also gives the stream a stable lower operating point instead of preserving 60 fps at the expense of clarity.

No application-level loop repeatedly changes track constraints. Browser WebRTC congestion control and LiveKit's stream allocator already contain recovery and hysteresis behavior; adding a second controller would risk competing decisions and more oscillation. The application constrains the available operating points instead: one high-resolution layer, one acceptable fallback, and a resolution-first degradation preference.

`adaptiveStream` remains enabled and uses `pixelDensity: 'screen'` so fullscreen and high-density displays do not under-request resolution. `dynacast` remains enabled to avoid encoding an unconsumed layer. Audio/video stay on the same LiveKit stream and retain the existing 0.5 second playout-delay hint.

LiveKit's backup codec is explicitly disabled for screen sharing. H.264 sharing must not silently start an additional VP8 encoder, because redundant high-frame-rate encoding increases sender CPU pressure and can itself trigger resolution degradation.

## Meeting-room visual direction

The meeting room becomes a quiet, stage-first broadcast console. The shared screen is the visual center; controls and meeting administration support it instead of competing with it.

The visual system is scoped to `.meeting-room` so create and join pages do not change:

- canvas: `#081419`;
- surface: `#10242b`;
- raised surface: `#17313a`;
- border: `rgba(196, 231, 236, 0.14)`;
- primary text: `#f3f8f9`;
- muted text: `#9cb2b8`;
- action accent: `#2fa9ba`;
- destructive action: `#d85c5c`;
- keyboard focus: `#f3c969`;
- consistent 10px and 14px radii with an 8px spacing rhythm.

Typography uses the platform's modern UI display face (`Segoe UI Variable Display`, `PingFang SC`, `Microsoft YaHei UI`, system fallbacks). The previous large Georgia greeting is removed. The one signature element is a restrained cyan live rail around the active screen stage; no decorative gradients, oversized headings, or unrelated shadows are added.

## Information architecture

### Top bar

The meeting-room header becomes a compact bar. It contains the room label, participant name, and connection state. The existing global language selector is visually incorporated into the same top area on meeting routes without changing locale behavior.

### Stage column

The screen stage sits in a single raised monitor surface. Empty and active states use the same frame, so the page does not reflow into unrelated visual blocks when sharing begins. Fullscreen and WebRTC diagnostics remain overlays inside the fullscreen element.

### Control dock

Only three actions are permanently visible:

- microphone on/off;
- start/stop screen sharing;
- leave meeting.

Connection state is a small status line rather than a competing control. Microphone device, speaker device, codec, and maximum bitrate move into an `Audio and sharing settings` disclosure. The former quality selector is deleted and replaced by static explanatory copy: `Adaptive 1080p · 30–60 fps`.

### Side rail

Participants and meeting management share one continuous surface. Participants remain immediately visible on desktop. Host and administrator actions sit under a `Meeting management` disclosure so destructive controls do not dominate the page. Existing authorization and password behavior do not change.

### Mobile

Below 720px, the top bar is 52px high, the stage uses the full content width, and the three primary actions form a compact row. Settings, participants, and meeting management are disclosures and remain in normal document flow. No large sticky control sheet occupies the viewport. Controls respect safe-area insets and maintain 44px minimum touch targets.

## Component boundaries

- `screen-share.ts` owns the single capture profile and chosen bitrate type.
- `room-controller.ts` translates that profile into explicit 1080p/720p LiveKit publish settings.
- `MeetingRoomPage` owns codec and bitrate state; it no longer owns a capture-profile selection.
- `MeetingControls` owns the primary-action row and settings disclosure.
- `ScreenStage` remains responsible for local/remote attachment and the fullscreen container.
- Participant, host, and administrator components keep their API behavior; wrappers and CSS unify their presentation.

## Error and compatibility behavior

- If capture cannot provide 1080p or 60 fps, the browser-provided track is published at its actual supported settings.
- If a browser rejects an optional frame-rate or content-hint preference, sharing continues with the captured track.
- The existing echo-risk decision, share authorization, cleanup, and meeting termination paths remain unchanged.
- H.264, VP8, and Auto retain their current negotiation semantics.
- Reduced-motion preferences disable nonessential visual transitions.

## Tests and verification

Focused tests must prove:

- the old standard/motion quality selector is absent;
- codec and 10/13/15 Mbps ceilings remain selectable and lock while sharing;
- capture requests 1920×1080 at up to 60 fps with `detail` and `maintain-resolution`;
- publication explicitly includes a 1280×720/30 fps fallback and no 540p layer;
- the control dock groups three primary actions separately from advanced settings;
- fullscreen video/audio attachment and diagnostics remain intact;
- host, administrator, and mobile-flow DOM behavior does not regress.

Final verification includes the affected tests, the full test suite, type checking, a production build, responsive screenshots, and a deployed HTTP health check.

## Deployment and rollback

Before extraction on the server, archive every source file that will be replaced into a versioned `/tmp/babagan-web-pre-<commit>.tgz` backup. Upload an exact checksum-verified archive of the committed files, rebuild only the web container unless shared contracts require otherwise, and retain the previous Docker image identifier in the deployment record. If health checks fail, restore the source archive and recreate the previous web image/container.
