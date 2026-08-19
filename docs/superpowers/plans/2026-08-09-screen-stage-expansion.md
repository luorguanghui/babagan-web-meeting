# Shared Screen Stage Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the shared screen across the meeting room during an active share and make the compact fullscreen icon clearly visible.

**Architecture:** Derive one `hasActiveScreenShare` boolean from the same local/remote media state already used by `ScreenStage`, and expose it as a modifier class on the meeting room. CSS changes only the desktop grid while that modifier is present; the existing Fullscreen API state remains responsible for hiding the button in true fullscreen.

**Tech Stack:** React 19, TypeScript, CSS Grid, Vitest, Testing Library

## Global Constraints

- Keep the existing 16:9 `object-fit: contain` display behavior.
- Show the fullscreen control only when a screen is active and hide it in true fullscreen.
- Use a 40×40 pixel high-contrast graphical fullscreen control.
- Do not change WebRTC publication, encoding, bitrate, or server services.

---

### Task 1: Conditional wide shared-screen layout

**Files:**
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/meeting/screen-share.test.tsx`
- Test: `apps/web/src/meeting/room.test.tsx`

**Interfaces:**
- Consumes: `screenState.stream` and `state.remoteScreenShare?.track`
- Produces: `hasActiveScreenShare: boolean` and the `meeting-room-sharing` CSS modifier class

- [ ] **Step 1: Write failing layout-state tests**

Add a positive assertion to the remote-share room test:

```tsx
expect(screen.getByRole('main')).toHaveClass('meeting-room-sharing');
```

Add a negative assertion to the ordinary room test:

```tsx
expect(screen.getByRole('main')).not.toHaveClass('meeting-room-sharing');
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/meeting/screen-share.test.tsx apps/web/src/meeting/room.test.tsx
```

Expected: the active-share assertion fails because the modifier class is absent.

- [ ] **Step 3: Implement the derived layout state**

In `MeetingRoomPage`, derive the state from the exact media passed to the stage:

```tsx
const hasActiveScreenShare = Boolean(stageStream || stageTrack);

return <main className={`meeting-room${hasActiveScreenShare ? ' meeting-room-sharing' : ''}`}>
```

- [ ] **Step 4: Expand the desktop grid and improve control contrast**

Add desktop rules that let the stage, header, status, dialog, and controls span both columns during sharing, then place participant and host panels below it. Increase the fullscreen button from 36×36 to 40×40 pixels and add a light border and shadow while preserving both fullscreen hiding mechanisms.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the focused command from Step 2. Expected: both files pass.

- [ ] **Step 6: Run full verification**

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Expected: all commands exit successfully.

- [ ] **Step 7: Commit and publish**

```powershell
git add apps/web/src/pages/meeting-room-page.tsx apps/web/src/styles.css apps/web/src/meeting/screen-share.test.tsx apps/web/src/meeting/room.test.tsx
git commit -m "Expand active screen sharing layout"
git push origin codex/web-meeting-implementation
```
