# Mobile controls, WebRTC overlay, and 60fps bitrate design

## Goal

Improve the meeting room on phones without changing the media architecture:

- let the control panel scroll naturally with the shared-screen stage;
- keep WebRTC diagnostics available in fullscreen without competing with the shared content;
- let a sharer choose a 10, 13, or 15 Mbps ceiling for 1080p60.

## Responsive controls

Desktop and tablet layouts keep the current sticky control dock. At phone widths of 640px or less, the dock becomes a normal document-flow element directly below the shared-screen stage. It moves with the rest of the meeting page and never occupies a permanently fixed portion of the viewport.

The existing control order and accessible labels remain unchanged. The 60fps bitrate field appears only when the high-motion 1080p60 profile is selected, avoiding an unnecessary mobile control for 1080p30.

## WebRTC diagnostics overlay

The diagnostics component becomes a child of the screen-stage fullscreen container. Its collapsed state is a small translucent control in the bottom-left corner. Expanding it opens a bounded, scrollable panel above that control; the shared video remains visible behind it.

Because both the trigger and panel live inside the screen-stage element, they remain available when that element enters browser fullscreen. The fullscreen control remains in the top-right corner, so the two controls do not overlap. The diagnostics control remains keyboard accessible and uses the existing localized labels.

When there is no active screen share, no diagnostics overlay is rendered and no statistics polling occurs.

## 1080p60 bitrate selection

The high-motion profile supports three manually selected bitrate ceilings:

- 10 Mbps, default;
- 13 Mbps;
- 15 Mbps.

The standard 1080p30 profile remains fixed at 8 Mbps. The selected 60fps ceiling is locked while sharing is starting or active, matching the existing profile and codec controls.

The chosen value is passed through the screen-share controller to LiveKit's `screenShareEncoding.maxBitrate`. Browser WebRTC congestion control continues to adapt the actual bitrate below that ceiling. The application does not automatically switch among the three ceilings.

## State and component boundaries

- `MeetingRoomPage` owns the selected 60fps bitrate and the sampled diagnostics snapshot.
- `MeetingControls` renders the conditional bitrate selector and reports selection changes.
- `ScreenStage` owns the fullscreen container and renders the diagnostics overlay supplied to it.
- `ScreenShareController` resolves the effective bitrate: 8 Mbps for standard, selected ceiling for motion.

No API, database, LiveKit server, capture resolution, frame-rate, codec, simulcast, or playout-delay changes are included.

## Tests

Focused component and screen-share tests will verify:

- the bitrate selector is hidden for 1080p30 and visible for 1080p60;
- 10, 13, and 15 Mbps selections are forwarded and locked during sharing;
- standard sharing still publishes at 8 Mbps;
- motion sharing publishes at the selected ceiling;
- diagnostics render inside the screen-stage fullscreen container;
- mobile CSS removes sticky positioning from the control dock.

Final verification is limited to the affected web tests, workspace type checking, and production build.
