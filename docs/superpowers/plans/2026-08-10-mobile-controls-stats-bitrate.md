# Mobile Controls, Fullscreen Diagnostics, and Bitrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make phone controls scroll with the meeting page, keep WebRTC diagnostics unobtrusively available in fullscreen, and add 10/13/15 Mbps ceilings for 1080p60 screen sharing.

**Architecture:** Keep selection state in `MeetingRoomPage`, let `MeetingControls` expose only controls relevant to the selected profile, and let `ScreenShareController` resolve the effective LiveKit encoding ceiling. Render diagnostics inside `ScreenStage`, the element that enters fullscreen, and use the existing responsive breakpoint to remove the mobile dock's sticky positioning.

**Tech Stack:** React 19, TypeScript, LiveKit Client, CSS, Vitest, Testing Library.

---

### Task 1: Add selectable 1080p60 bitrate ceilings

**Files:**
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/meeting/screen-share.ts`
- Modify: `apps/web/src/components/meeting-controls.tsx`
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Modify: `apps/web/src/i18n.tsx`

- [ ] Add failing tests proving the selector is hidden for 1080p30, shown for 1080p60, emits 10/13/15 Mbps values, and is disabled while sharing.
- [ ] Add failing controller tests proving 1080p30 remains at 8 Mbps while 1080p60 publishes at the selected ceiling.
- [ ] Run `pnpm vitest run apps/web/src/meeting/screen-share.test.tsx` and confirm the new assertions fail for the expected missing behavior.
- [ ] Add a narrow `MotionBitrate` type and a default of `10_000_000`; pass the chosen value to `screenShareEncoding.maxBitrate` only for the motion profile.
- [ ] Add the conditional localized selector and wire its state through `MeetingRoomPage` without changing native WebRTC congestion control.
- [ ] Re-run the focused test and confirm it passes.
- [ ] Commit: `Add selectable 60fps bitrate ceilings`.

### Task 2: Place diagnostics in fullscreen and unstick phone controls

**Files:**
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/components/screen-stage.tsx`
- Modify: `apps/web/src/components/webrtc-stats-panel.tsx`
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] Add a failing component test proving diagnostics are descendants of the active `.screen-stage` fullscreen container and absent without an active share.
- [ ] Run the focused test and confirm RED.
- [ ] Let `ScreenStage` render overlay children inside the active fullscreen container, then move the existing diagnostics panel into that slot.
- [ ] Style collapsed diagnostics as a small translucent bottom-left control; bound and scroll the expanded panel without covering the fullscreen button.
- [ ] At widths up to 640px, change `.meeting-control-dock` to normal document flow (`position: static; bottom: auto`) so it scrolls with the stage.
- [ ] Re-run the focused test and confirm GREEN.
- [ ] Commit: `Improve mobile controls and fullscreen diagnostics`.

### Task 3: Verify, publish, and deploy

**Files:**
- Verify all modified web files and deployment output.

- [ ] Run `pnpm vitest run apps/web/src/meeting/screen-share.test.tsx`.
- [ ] Run `pnpm typecheck` and `pnpm build`.
- [ ] Run `git diff --check` and review the final diff for accidental scope changes.
- [ ] Push `codex/web-meeting-implementation` to GitHub.
- [ ] Deploy the exact committed source files to `/opt/babagan-web-meeting`, rebuild the web container, and check the application returns HTTP 200.

## Self-review

- The plan preserves the approved 8 Mbps 1080p30 behavior and defaults 1080p60 to 10 Mbps.
- The 13/15 Mbps choices are ceilings, not forced output rates or an application-level adaptation algorithm.
- The diagnostics move changes ownership only in the render tree; statistics collection remains conditional on an active share.
- The mobile change is isolated to the existing phone breakpoint and does not alter desktop sticky controls.
