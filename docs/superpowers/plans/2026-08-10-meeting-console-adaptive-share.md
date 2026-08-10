# Meeting Console and Adaptive Screen Share Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a cohesive stage-first meeting room and one adaptive 1080p screen-share mode that prefers 30–60 fps at 1080p and uses only 720p30 as a spatial fallback.

**Architecture:** Replace profile selection with one capture policy owned by `screen-share.ts`; translate it into explicit two-layer LiveKit publish settings in `room-controller.ts`. Reshape the existing React components into a compact action dock plus disclosure-based settings and apply a meeting-scoped visual token system without changing API or authorization behavior.

**Tech Stack:** TypeScript 5.9, React 19, LiveKit Client 2.21, CSS, Vitest, Testing Library.

## Global Constraints

- No server-side media encoding or transcoding.
- Capture target is 1920×1080 at up to 60 fps with `detail` and `maintain-resolution`.
- High-layer ceilings remain exactly 10, 13, and 15 Mbps; default is 10 Mbps.
- The only fallback layer is 1280×720, 30 fps, 3.5 Mbps; no 540p layer may be published.
- Screen-share backup codec is disabled so only the selected codec is encoded.
- Existing audio isolation, 0.5 second audio/video playout hint, permissions, host actions, and administrator-password termination remain unchanged.
- Meeting-room visual styles must be scoped to `.meeting-room` or `.app-root:has(.meeting-room)` and must not restyle create/join pages.
- Mobile controls remain in normal document flow and expose 44px minimum touch targets.

---

### Task 1: Replace capture profiles with one adaptive share policy

**Files:**
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/meeting/screen-share.ts`
- Modify: `apps/web/src/pages/meeting-room-page.tsx`

**Interfaces:**
- Produces: `screenShareBitrates`, `ScreenShareBitrate`, `adaptiveCaptureProfile`, and `ScreenShareController.start(codec?, bitrate?)`.
- Consumes: existing grant, capture, audio-isolation, publish, and release dependencies.

- [ ] **Step 1: Write failing adaptive-profile tests**

Replace the standard/motion table with assertions that `start('h264', 13_000_000)` requests `{ width: 1920, height: 1080, frameRate: 60 }`, assigns `contentHint = 'detail'`, and publishes:

```ts
expect(publish).toHaveBeenCalledWith(stream, {
  maxBitrate: 13_000_000,
  frameRate: 60,
  degradationPreference: 'maintain-resolution',
  codec: 'h264'
});
```

Retain existing audio-isolation, grant-rejection, ended-track, and cleanup tests but call `start()` without a profile.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run apps/web/src/meeting/screen-share.test.tsx`

Expected: failures because `start` still interprets its first argument as a capture profile and the motion profile uses `motion`/`maintain-framerate`.

- [ ] **Step 3: Implement the single policy**

Replace `captureProfiles` with:

```ts
export const adaptiveCaptureProfile = {
  width: 1920,
  height: 1080,
  frameRate: 60,
  maxBitrate: 10_000_000,
  contentHint: 'detail',
  degradationPreference: 'maintain-resolution'
} as const;
export const screenShareBitrates = [10_000_000, 13_000_000, 15_000_000] as const;
export type ScreenShareBitrate = typeof screenShareBitrates[number];
```

Change `start` to `start(codec: ScreenShareCodec = 'h264', bitrate: ScreenShareBitrate = 10_000_000)` and remove `profile` from `ScreenShareState`. Update `MeetingRoomPage` to remove profile state and call `screenShare.start(screenCodec, screenBitrate)`.

- [ ] **Step 4: Verify GREEN**

Run the focused test and `pnpm --filter @meeting/web typecheck`.

- [ ] **Step 5: Commit**

Commit message: `Unify adaptive screen capture profile`.

### Task 2: Publish explicit 1080p60 and 720p30 layers

**Files:**
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/meeting/room.test.tsx`
- Modify: `apps/web/src/meeting/room-controller.ts`

**Interfaces:**
- Consumes: `{ maxBitrate, frameRate, degradationPreference, codec }` from Task 1.
- Produces: exact LiveKit `TrackPublishOptions` with two spatial operating points.

- [ ] **Step 1: Write failing LiveKit option tests**

Assert room creation contains:

```ts
adaptiveStream: { pixelDensity: 'screen' },
dynacast: true
```

Assert screen publication contains:

```ts
simulcast: true,
backupCodec: false,
screenShareEncoding: { maxBitrate: 13_000_000, maxFramerate: 60 },
screenShareSimulcastLayers: [expect.objectContaining({
  width: 1280,
  height: 720,
  encoding: expect.objectContaining({ maxBitrate: 3_500_000, maxFramerate: 30 })
})],
degradationPreference: 'maintain-resolution',
videoCodec: 'h264'
```

Also assert the serialized layer list contains neither width `960` nor height `540`.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run apps/web/src/meeting/room.test.tsx apps/web/src/meeting/screen-share.test.tsx`

Expected: current room uses `adaptiveStream: true` and publication inherits default 540p simulcast plus backup codec.

- [ ] **Step 3: Implement explicit publish settings**

Import `VideoPreset` from `livekit-client`, create one module-level fallback preset:

```ts
const screenShareFallback = new VideoPreset(1280, 720, 3_500_000, 30, 'medium');
```

Use `{ adaptiveStream: { pixelDensity: 'screen' }, dynacast: true }` for `Room`, and add `simulcast: true`, `backupCodec: false`, and `screenShareSimulcastLayers: [screenShareFallback]` to video publication options.

- [ ] **Step 4: Verify GREEN**

Run both focused tests and web type checking.

- [ ] **Step 5: Commit**

Commit message: `Stabilize adaptive screen publication`.

### Task 3: Consolidate the meeting controls

**Files:**
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/components/meeting-controls.tsx`
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Modify: `apps/web/src/i18n/i18n.tsx`

**Interfaces:**
- Consumes: codec and `ScreenShareBitrate` state from Tasks 1–2.
- Produces: `.meeting-primary-actions`, `.meeting-settings`, and `.meeting-settings-grid` structure.

- [ ] **Step 1: Write failing control-layout tests**

Render `MeetingControls` and assert:

```ts
expect(screen.queryByLabelText('Screen quality')).not.toBeInTheDocument();
expect(screen.getByText('Adaptive 1080p · 30–60 fps')).toBeVisible();
const actions = screen.getByRole('group', { name: 'Primary meeting actions' });
expect(within(actions).getAllByRole('button')).toHaveLength(3);
const settings = screen.getByText('Audio and sharing settings').closest('details');
expect(settings).toContainElement(screen.getByLabelText('Maximum screen-share bitrate'));
expect(settings).toContainElement(screen.getByLabelText('Screen-share codec'));
```

Select 13 and 15 Mbps and verify the callback receives the numeric values; rerender active sharing and verify bitrate and codec remain disabled.

- [ ] **Step 2: Verify RED**

Run the focused screen-share test; expect missing group/disclosure and the obsolete quality selector to fail assertions.

- [ ] **Step 3: Implement semantic grouping and copy**

Remove all profile props. Render connection/adaptive-mode text in `.meeting-control-status`, the microphone/share/leave buttons in `<div role="group" aria-label={t('controls.primaryActions')}>`, and all selects in:

```tsx
<details className="meeting-settings">
  <summary>{t('controls.settings')}</summary>
  <div className="meeting-settings-grid">…</div>
</details>
```

Add English and Simplified Chinese messages for primary actions, settings, adaptive mode, and maximum bitrate. Preserve all existing form-control accessible names.

- [ ] **Step 4: Verify GREEN**

Run focused tests and i18n tests.

- [ ] **Step 5: Commit**

Commit message: `Consolidate meeting controls`.

### Task 4: Apply the stage-first meeting-room design

**Files:**
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Modify: `apps/web/src/components/screen-stage.tsx`
- Modify: `apps/web/src/components/participant-list.tsx`
- Modify: `apps/web/src/components/host-menu.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: existing screen stage, participants, host authorization, diagnostics, and consolidated controls.
- Produces: `.meeting-topbar`, `.meeting-stage-shell`, `.meeting-side-rail`, and mobile disclosure layout.

- [ ] **Step 1: Write failing structural tests**

Assert the meeting heading is compact, the screen stage is inside `.meeting-stage-shell`, primary controls remain below that shell, the side rail contains both participant and host/admin regions, and all previously tested fullscreen/audio attachment behavior remains unchanged.

- [ ] **Step 2: Verify RED**

Run the focused test and confirm missing stage-shell/topbar classes cause the failures.

- [ ] **Step 3: Reshape markup without changing behavior**

Replace the large greeting header with `.meeting-topbar`, wrap `ScreenStage` in `.meeting-stage-shell`, and keep diagnostics as its child. Wrap host content in a `.meeting-management` disclosure while leaving authorization effects mounted. Use native `<details>` for mobile-friendly progressive disclosure and preserve heading IDs and accessible labels.

- [ ] **Step 4: Implement the scoped token system**

Define the exact tokens from the design spec under `.meeting-room`; style a `minmax(0, 1fr) 18rem` desktop workspace, cohesive dark surfaces, a restrained active-stage cyan rail, compact action buttons, disclosure settings, unified side rail, keyboard focus, reduced motion, and mobile rules below 45rem. Do not add dependencies or global typography changes outside the meeting route.

- [ ] **Step 5: Verify GREEN**

Run screen-share, room, host-menu, and i18n tests; then run web type checking.

- [ ] **Step 6: Commit**

Commit message: `Redesign the meeting workspace`.

### Task 5: Verify, publish, and deploy with rollback

**Files:**
- Verify all modified files.
- Create server backup `/tmp/babagan-web-pre-<commit>.tgz`.

- [ ] Run `pnpm test`, `pnpm typecheck`, and `pnpm build`.
- [ ] Run `git diff --check` and confirm the worktree is clean after commit.
- [ ] Inspect desktop and mobile responsive renders; confirm the stage, primary actions, disclosures, fullscreen button, and diagnostics are usable.
- [ ] Push `codex/web-meeting-implementation` to GitHub.
- [ ] Record the currently running web image ID and archive every replaced server file before extraction.
- [ ] Upload a SHA-256-verified archive of the committed source, rebuild only the web container, and recreate it.
- [ ] Confirm the web container is healthy and `https://meet.babagan.cloud/create` returns HTTP 200.
- [ ] Retain the source backup and previous image ID, and print the exact rollback command in the final report.

## Self-review

- All media constraints from the specification map to Tasks 1–2; the old profile selector is removed in Tasks 1 and 3.
- The UI hierarchy, mobile disclosure behavior, accessibility, localization, and style scoping map to Tasks 3–4.
- Interface names are consistent across controller, page, and controls.
- Deployment includes both source and image rollback evidence before mutation.
- There are no server API, database, token, permission, or transcoding changes.
