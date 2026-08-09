# Meeting Room Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lower the 1080p60 screen-share bitrate ceiling to 11.5 Mbps and reshape the meeting room into a presentation-first desktop workspace with a unified side rail and first-viewport control dock.

**Architecture:** Keep all meeting, media, permission, and localization behavior in the existing components. Add layout-only wrappers in `MeetingRoomPage`, keep profile values in `screen-share.ts`, and express desktop/mobile behavior in the existing stylesheet without new runtime dependencies.

**Tech Stack:** React 19, TypeScript, CSS Grid/Flexbox, Vitest, Testing Library, Vite.

## Global Constraints

- The `motion` profile must use `11_500_000` bits per second, 60 fps, and `maintain-framerate`.
- Do not add server transcoding, API, LiveKit configuration, or networking changes.
- Preserve bilingual copy, keyboard focus, alert/status semantics, screen-share audio handling, and fullscreen behavior.
- Keep shared video uncropped with `object-fit: contain`.
- Add no fonts, icon packages, animation, or runtime dependencies.

---

### Task 1: Lower the 60 fps publish ceiling

**Files:**
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/meeting/screen-share.ts`

**Interfaces:**
- Consumes: `captureProfiles.motion` and `createScreenShareController().start('motion')`.
- Produces: a motion profile that publishes `{ maxBitrate: 11_500_000, frameRate: 60, degradationPreference: 'maintain-framerate' }`.

- [ ] **Step 1: Change the motion-profile expectation first**

```tsx
['motion', captureProfiles.motion, 11_500_000, 'motion', 'maintain-framerate']
```

Replace only the existing `motion` row in the current `it.each` table with this tuple; keep the standard row and the test body unchanged.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run apps/web/src/meeting/screen-share.test.tsx -t "requests the exact motion"`

Expected: FAIL because the controller publishes `13_000_000` instead of `11_500_000`.

- [ ] **Step 3: Make the minimal profile change**

```ts
motion: {
  width: 1920,
  height: 1080,
  frameRate: 60,
  maxBitrate: 11_500_000,
  contentHint: 'motion',
  degradationPreference: 'maintain-framerate'
}
```

- [ ] **Step 4: Run the focused screen-share suite and verify GREEN**

Run: `pnpm vitest run apps/web/src/meeting/screen-share.test.tsx`

Expected: all screen-share tests pass.

- [ ] **Step 5: Commit the profile change**

```bash
git add apps/web/src/meeting/screen-share.ts apps/web/src/meeting/screen-share.test.tsx
git commit -m "Tune 60fps screen share bitrate"
```

### Task 2: Introduce the presentation workspace structure

**Files:**
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Modify: `apps/web/src/components/meeting-controls.tsx`
- Modify: `apps/web/src/i18n/i18n.tsx`

**Interfaces:**
- Consumes: the existing `hasActiveScreenShare`, notice states, `ScreenStage`, `ParticipantList`, `HostMenu`, and `MeetingControls`.
- Produces: `.meeting-room-header`, `.meeting-notices`, `.meeting-workspace`, `.meeting-side-rail`, and `.meeting-control-dock` structural hooks while retaining `meeting-room-sharing`.

- [ ] **Step 1: Add a failing workspace structure test**

After rendering a room with a remote share, assert the intended parent relationships:

```tsx
const main = screen.getByRole('main');
const stage = screen.getByLabelText('Shared screen stage');
const sideRail = screen.getByLabelText('Meeting side panel');
const controls = screen.getByLabelText('Meeting controls');

expect(main).toHaveClass('meeting-room-sharing');
expect(stage.parentElement).toHaveClass('meeting-stage-column');
expect(stage.parentElement?.parentElement).toHaveClass('meeting-workspace');
expect(sideRail).toContainElement(screen.getByRole('heading', { name: 'Participants (1)' }));
expect(sideRail).toContainElement(screen.getByRole('heading', { name: 'Host controls' }));
expect(controls).toHaveClass('meeting-control-dock');
```

- [ ] **Step 2: Run the new structure test and verify RED**

Run: `pnpm vitest run apps/web/src/meeting/screen-share.test.tsx -t "groups the presentation workspace"`

Expected: FAIL because `Meeting side panel`, `.meeting-workspace`, and `.meeting-control-dock` do not exist.

- [ ] **Step 3: Add the localized side-panel label**

Add `'room.sidePanel': 'Meeting side panel'` to English and `'room.sidePanel': '会议侧栏'` to Simplified Chinese.

- [ ] **Step 4: Group the existing components without moving behavior**

Use this structure in `MeetingRoomPage`:

```tsx
<header className="meeting-room-header">
  <div className="meeting-room-title">
    <p className="eyebrow">{t('room.eyebrow')}</p>
    <h1>{t('room.heading', { name: join.participantName })}</h1>
  </div>
  <ConnectionBanner state={reconnectState} online={online} rateLimited={reconnectRateLimited} />
</header>
<section className="meeting-notices" aria-live="polite">
  {(connectionError || notice) && <p role={connectionError ? 'alert' : 'status'}>{connectionError ?? notice}</p>}
  {screenState.audioGuidance && <p role="status">{localizedScreenGuidance(screenState.audioGuidance, t)}</p>}
  {systemAudioDecision && <section
    className="system-audio-warning"
    role="dialog"
    aria-modal="true"
    aria-labelledby="system-audio-warning-title"
  >
    <h2 id="system-audio-warning-title">{t('audioWarning.heading')}</h2>
    <p>{t('audioWarning.description', { surface: systemAudioDecision.displaySurface })}</p>
    <button type="button" onClick={() => resolveSystemAudioDecision('video-only')}>{t('audioWarning.videoOnly')}</button>
    <button type="button" onClick={() => resolveSystemAudioDecision('share-audio')}>{t('audioWarning.continue')}</button>
    <button type="button" onClick={() => resolveSystemAudioDecision('cancel')}>{t('audioWarning.cancel')}</button>
  </section>}
</section>
<div className="meeting-workspace">
  <div className="meeting-stage-column">
    <ScreenStage
      stream={stageStream}
      track={stageTrack}
      audioTrack={stageAudioTrack}
      sharerName={sharerName}
    />
    <MeetingControls
      className="meeting-control-dock"
      connection={state.connection}
      microphoneEnabled={state.microphoneEnabled}
      audioPlaybackBlocked={state.audioPlaybackBlocked}
      devices={devices}
      leaving={leaving}
      screenShareAuthorized={hostAuthorized || Boolean(state.screenShareAuthorized)}
      screenShareActive={screenState.status === 'sharing'}
      screenShareBusy={screenState.status === 'starting'}
      screenProfile={screenProfile}
      onMicrophoneToggle={() => void controller.setMicrophoneEnabled(!state.microphoneEnabled)}
      onMicrophoneDeviceChange={(deviceId) => void controller.setMicrophoneEnabled(state.microphoneEnabled, deviceId)}
      onSpeakerDeviceChange={(deviceId) => void changeSpeaker(deviceId)}
      onResumeAudio={() => void controller.resumeAudioPlayback()}
      onScreenProfileChange={setScreenProfile}
      onScreenShareToggle={() => void toggleScreenShare()}
      onLeave={() => void leave()}
    />
  </div>
  <aside className="meeting-side-rail" aria-label={t('room.sidePanel')}>
    <ParticipantList participants={state.participants} />
    <HostMenu
      participants={hostParticipants}
      authorizeHost={authorizeHost}
      onAuthorizationChange={authorizationChanged}
      onGrantShare={(identity) => meetingApi.grantShare(slug, identity)}
      onRevokeShare={() => meetingApi.revokeShare(slug)}
      onKick={(identity) => meetingApi.kick(slug, identity)}
      onEndMeeting={() => meetingApi.end(slug)}
      onEnded={() => onTerminal?.('ended')}
    />
  </aside>
</div>
```

Extend `MeetingControlsProps` with `className?: string` and render `className={['meeting-controls', props.className].filter(Boolean).join(' ')}` so its semantics and behavior stay unchanged.

- [ ] **Step 5: Run the structure test and verify GREEN**

Run: `pnpm vitest run apps/web/src/meeting/screen-share.test.tsx -t "groups the presentation workspace"`

Expected: PASS.

- [ ] **Step 6: Run related component suites**

Run: `pnpm vitest run apps/web/src/meeting/screen-share.test.tsx apps/web/src/meeting/room.test.tsx apps/web/src/accessibility.test.tsx`

Expected: all selected tests pass.

- [ ] **Step 7: Commit the workspace structure**

```bash
git add apps/web/src/pages/meeting-room-page.tsx apps/web/src/components/meeting-controls.tsx apps/web/src/i18n/i18n.tsx apps/web/src/meeting/screen-share.test.tsx
git commit -m "Reshape meeting room workspace"
```

### Task 3: Implement the viewport-oriented visual layout

**Files:**
- Modify: `apps/web/src/styles.css`
- Verify: `apps/web/src/meeting/screen-share.test.tsx`

**Interfaces:**
- Consumes: the structural class names produced by Task 2.
- Produces: presentation-first desktop and single-column mobile layouts without changing React state or event handling.

- [ ] **Step 1: Add the room-scoped CSS layout**

Implement these concrete behaviors:

```css
.meeting-room { display: grid; gap: .75rem; margin: 0 auto; max-width: 100rem; min-height: calc(100vh - 3.25rem); padding: clamp(.75rem, 1.5vw, 1.5rem); }
.meeting-room-header { align-items: center; display: flex; gap: 1rem; justify-content: space-between; }
.meeting-room-title { min-width: 0; }
.meeting-room-title .eyebrow { margin-bottom: .25rem; }
.meeting-room-header h1 { font-size: clamp(1.45rem, 2.4vw, 2.3rem); line-height: 1.05; }
.meeting-room-header .connection-banner { border: 0; border-radius: 999px; flex: 0 0 auto; margin: 0; padding: .45rem .75rem; }
.meeting-notices { display: grid; gap: .5rem; }
.meeting-notices:empty { display: none; }
.meeting-notices > p { margin: 0; }
.meeting-workspace { align-items: start; display: grid; gap: 1rem; min-width: 0; }
.meeting-stage-column { display: grid; gap: .75rem; min-width: 0; }
.meeting-side-rail { background: #f7fafb; border: 1px solid #cad8dd; display: grid; gap: 0; min-width: 0; }
.meeting-side-rail .participant-list, .meeting-side-rail .host-menu { background: transparent; border: 0; padding: 1rem; }
.meeting-side-rail .host-menu { border-top: 1px solid #d8e0e4; }
.meeting-control-dock { background: rgba(220, 231, 234, .97); border: 1px solid #bdcdd2; box-shadow: 0 .75rem 2rem rgba(17, 39, 51, .12); bottom: .5rem; position: sticky; z-index: 3; }
.meeting-control-dock label { flex: 1 1 10rem; min-width: 9rem; }
.meeting-control-dock select { width: 100%; }

@media (min-width: 64rem) {
  .meeting-workspace { grid-template-columns: minmax(0, 1fr) minmax(17.5rem, 17.5rem); }
  .meeting-side-rail { align-content: start; max-height: calc(100vh - 8rem); overflow: auto; }
  .meeting-room-sharing .screen-stage { aspect-ratio: auto; height: min(calc(100vh - 14rem), calc((100vw - 22rem) * .5625)); min-height: 24rem; }
}

@media (max-width: 63.999rem) {
  .meeting-room-header { align-items: flex-start; flex-direction: column; }
  .meeting-workspace { grid-template-columns: minmax(0, 1fr); }
  .meeting-stage-column { order: 1; }
  .meeting-side-rail { order: 2; }
}
```

Retain the existing `.screen-stage`, `.screen-stage video`, fullscreen, control, alert, button focus, and empty-stage declarations that are not superseded above. Delete the old desktop rules that place `ParticipantList` and `HostMenu` in independent main-grid rows, because the new wrappers own their position.

- [ ] **Step 2: Build the web app to catch invalid selectors or imports**

Run: `pnpm --filter @meeting/web build`

Expected: Vite production build exits 0.

- [ ] **Step 3: Run the relevant regression suite**

Run: `pnpm vitest run apps/web/src/meeting/screen-share.test.tsx apps/web/src/meeting/room.test.tsx apps/web/src/accessibility.test.tsx`

Expected: all selected tests pass, including fullscreen behavior.

- [ ] **Step 4: Commit the visual layout**

```bash
git add apps/web/src/styles.css
git commit -m "Refine presentation-first meeting layout"
```

### Task 4: Verify, inspect, publish, and deploy

**Files:**
- Verify only: repository and deployed web artifact

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a clean, pushed branch and a web-only production deployment.

- [ ] **Step 1: Run complete automated verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`

Expected: all tests pass; typecheck, lint, and build exit 0. A Vite chunk-size warning is acceptable if there is no build failure.

- [ ] **Step 2: Inspect the UI at desktop and narrow widths**

Use a real browser at approximately 2048×1114 and below 64rem. Verify that the stage dominates the desktop workspace, the side rail groups participant and host panels, controls are initially visible, the mobile order is correct, and fullscreen remains visible before entering fullscreen.

- [ ] **Step 3: Push the current branch**

Run: `git push origin codex/web-meeting-implementation`

Expected: remote branch head equals local `HEAD`.

- [ ] **Step 4: Deploy only the web service**

Build a release image from the verified `apps/web/dist`, update the release override to that image, and run Docker Compose with `--no-deps --no-build --pull never web`. Record API, LiveKit, and Caddy container IDs before and after and require them to remain unchanged.

- [ ] **Step 5: Verify the public artifact**

Fetch `https://meet.babagan.cloud/` and its referenced JS/CSS. Require HTTP 200, confirm the CSS contains `.meeting-workspace` and `.meeting-control-dock`, and confirm the public JS contains the `Meeting side panel` label.
