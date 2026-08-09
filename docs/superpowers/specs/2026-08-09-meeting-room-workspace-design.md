# Meeting Room Workspace Design

## Goal

Make desktop screen sharing the visual priority without pushing essential controls below the fold, while reducing the 1080p60 screen-share bitrate ceiling from 13 Mbps to 11.5 Mbps.

## Scope

- Change the `motion` screen-share profile to `11_500_000` bits per second and retain its 60 fps capture target and maintain-framerate degradation preference.
- Reshape only the in-meeting workspace. Creation, joining, authorization, media transport, and server-side forwarding behavior remain unchanged.
- Preserve localization, keyboard focus, responsive behavior, screen-share audio handling, and the existing fullscreen flow.

## Desktop Layout

At widths of 64rem and above, the meeting room becomes a viewport-oriented workspace:

1. A compact top bar contains the room label, participant name, and connection state. The room-specific heading is smaller than the marketing-page heading so it does not consume presentation space.
2. The center workspace uses two columns: a flexible presentation stage and an approximately 280px side rail.
3. The presentation stage keeps a 16:9 frame, `object-fit: contain`, and a dark background. It expands within the available viewport height without cropping shared content.
4. The side rail vertically groups participants and host controls into one coherent work area. The existing component semantics and actions remain intact.
5. A compact control dock sits below the presentation stage and remains visible in the initial viewport. It contains connection/microphone state, microphone and speaker selectors, quality selection, screen-share action, and leave action.
6. Notices, reconnect information, and the system-audio decision remain above the stage and use compact inline/banner treatment. They must not overlap the stage or controls.

The fullscreen action remains mounted whenever a screen-share video exists, stays visible at the stage's upper-right corner, and is hidden only by the existing standard and WebKit fullscreen CSS selectors while the stage is actually fullscreen.

## Responsive Layout

Below 64rem, the workspace becomes a single column in this order: top bar, notices, presentation stage, control dock, participants, host controls. Controls may wrap, but all inputs and buttons retain usable touch targets and visible focus states.

## Visual Direction

- Retain the product's teal and blue-gray palette so this change feels continuous with the creation and join pages.
- Use the dark presentation stage as the single signature visual element; surrounding panels stay quiet and light.
- Reduce room-only heading size, padding, and panel gaps. Do not change the global display typography used by non-meeting pages.
- Keep borders and radii restrained and use spacing to show the relationship between the participant list and host tools.
- Add no new fonts, icon packages, animation, or runtime dependencies.

## Component Boundaries

- `MeetingRoomPage` owns the workspace structure and active-share state class.
- `ConnectionBanner`, `ScreenStage`, `ParticipantList`, `HostMenu`, and `MeetingControls` keep their current behavioral responsibilities.
- A presentational workspace/sidebar wrapper may be added to `MeetingRoomPage`; it must not move media or permission state into a new component.
- `screen-share.ts` remains the single source of screen-share profile values.

## Error and State Handling

Connection, device, screen-share, and audio-guidance messages retain their current roles and localized copy. Layout changes must not suppress alerts, status messages, or dialogs. Empty screen-share state remains visibly labeled, and disabled/busy controls retain their current behavior.

## Verification

- A regression test must fail against the old 13 Mbps value and pass only when the motion profile publishes with `11_500_000` bits per second at 60 fps.
- Component tests must cover the desktop workspace structure, active-share class, side rail grouping, control dock placement, and fullscreen control behavior.
- Existing accessibility, meeting room, screen sharing, localization, and host-control tests must continue to pass.
- Run the complete test suite, type checking, linting, and production build.
- Inspect a desktop rendering at the screenshot's approximate 2048×1114 viewport and a narrow responsive viewport before deployment.

## Non-Goals

- No server-side transcoding or bitrate control.
- No camera tile system, chat, recording, collapsible panels, or new meeting features.
- No changes to LiveKit credentials, networking, API routes, or meeting lifecycle.
