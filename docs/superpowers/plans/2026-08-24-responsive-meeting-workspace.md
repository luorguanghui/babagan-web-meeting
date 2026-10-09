# Responsive Meeting Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the create, join, and meeting-room surfaces around the approved immersive desktop workspace and mobile bottom-sheet interaction model while preserving media behavior, source aspect ratio, fullscreen, and WebRTC diagnostics.

**Architecture:** Shared layout primitives provide one product shell for task pages and the meeting workspace. `MeetingRoomPage` owns drawer/menu state but leaves media state in existing controllers. `ScreenStage` owns real source aspect ratio and fullscreen; existing statistics move into a low-frequency drawer without changing collection logic.

**Tech Stack:** React 19, React Router 7, TypeScript, CSS, `lucide-react`, LiveKit client, Vitest, Testing Library, Playwright/local E2E harness.

**Spec:** `docs/superpowers/specs/2026-08-24-responsive-meeting-ui-and-terminal-links-design.md`

## Global Constraints

- Preserve existing teal identity and the exact meeting media/control behavior.
- No chat, camera, recording, reactions, files, or new analytics.
- Shared content always uses `object-fit: contain`; never crop, stretch, or distort.
- Nonportrait sources use their real aspect ratio as the preferred stage ratio.
- Fullscreen remains permanently available on the stage.
- WebRTC data remains available as a low-frequency diagnostic entry.
- Desktop target: 1440×900 and 1920×1080; mobile target: 390×844 and 320×568.
- Touch targets are at least 44px; primary actions target 48px.
- Existing controllers, API contracts, LiveKit, P2P, TURN, and SFU behavior remain unchanged.
- Use `lucide-react` icons; no handwritten SVG, emoji, or character-symbol icons.

---

## File Structure

**Create:**

- `apps/web/src/components/app-shell.tsx` — global product bar and page container.
- `apps/web/src/components/task-page-layout.tsx` — desktop two-column/mobile one-column layout for create/join.
- `apps/web/src/components/meeting-top-bar.tsx` — meeting title, connection path, count, drawer triggers.
- `apps/web/src/components/meeting-drawer.tsx` — accessible desktop side drawer/mobile bottom sheet.
- `apps/web/src/components/meeting-menu.tsx` — low-frequency meeting navigation rows.
- `apps/web/src/components/meeting-workspace.test.tsx` — drawer/menu and responsive semantic tests.

**Modify:**

- `apps/web/package.json`, `pnpm-lock.yaml` — `lucide-react` dependency.
- `apps/web/src/app.tsx` — use `AppShell`.
- `apps/web/src/components/language-selector.tsx` — compact app-bar presentation.
- `apps/web/src/pages/create-meeting-page.tsx` — task layout.
- `apps/web/src/pages/join-lobby-page.tsx` — task layout and collapsible device check.
- `apps/web/src/pages/meeting-room-page.tsx` — workspace/drawer composition.
- `apps/web/src/components/meeting-controls.tsx` — primary dock only; settings content becomes reusable sections.
- `apps/web/src/components/participant-list.tsx`, `host-menu.tsx` — drawer-friendly rows.
- `apps/web/src/components/screen-stage.tsx` — source aspect ratio and stage metadata.
- `apps/web/src/components/webrtc-stats-panel.tsx` — embedded diagnostic mode.
- `apps/web/src/i18n/i18n.tsx` — shell, menu, drawer, loading, and diagnostic copy.
- `apps/web/src/styles.css` — full responsive visual system.
- Existing page/component tests — new structure and regressions.

---

### Task 1: Add the product shell and task-page layout primitives

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/src/components/app-shell.tsx`
- Create: `apps/web/src/components/task-page-layout.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/components/language-selector.tsx`
- Test: `apps/web/src/accessibility.test.tsx`

**Interfaces:**
- Produces: `AppShell({ children })`, `TaskPageLayout({ eyebrow, title, lede, context, children })`.
- Consumes: `LanguageSelector`, React Router page children.

- [ ] **Step 1: Write failing shell semantics tests**

```tsx
it('groups product identity and language in one application header', () => {
  render(<MemoryRouter><App /></MemoryRouter>);
  const banner = screen.getByRole('banner');
  expect(within(banner).getByText('Babagan')).toBeVisible();
  expect(within(banner).getByLabelText('Language')).toBeVisible();
});

it('exposes task content and supporting context as separate labelled regions', () => {
  render(<TaskPageLayout
    eyebrow="Private meeting"
    title="Create a meeting"
    lede="Create a short-lived room."
    context={<p>Only invited people can join.</p>}
  ><form aria-label="Meeting form" /></TaskPageLayout>);

  expect(screen.getByRole('region', { name: 'Create a meeting' })).toBeVisible();
  expect(screen.getByRole('complementary')).toHaveTextContent('Only invited');
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
pnpm --filter @meeting/web test -- apps/web/src/accessibility.test.tsx -t "application header|supporting context"
```

Expected: `AppShell` / `TaskPageLayout` are missing and language remains outside a banner.

- [ ] **Step 3: Install the approved icon library**

```powershell
pnpm --filter @meeting/web add lucide-react
```

- [ ] **Step 4: Implement focused layout primitives**

`app-shell.tsx`:

```tsx
import type { ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { LanguageSelector } from './language-selector.js';

export function AppShell({ children }: { children: ReactNode }) {
  return <div className="app-shell">
    <header className="app-bar">
      <a className="app-brand" href="/create" aria-label="Babagan home">
        <ShieldCheck aria-hidden="true" size={20} /><span>Babagan</span>
      </a>
      <LanguageSelector />
    </header>
    {children}
  </div>;
}
```

`TaskPageLayout` provides `.task-page`, `.task-context`, and `.task-surface` regions. Keep data fetching and form state in the page components.

- [ ] **Step 5: Run tests and verify GREEN**

Run Step 2 plus `pnpm --filter @meeting/web typecheck`.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/package.json pnpm-lock.yaml apps/web/src/app.tsx apps/web/src/components/app-shell.tsx apps/web/src/components/task-page-layout.tsx apps/web/src/components/language-selector.tsx apps/web/src/accessibility.test.tsx
git commit -m "feat(web): add responsive application shell"
```

---

### Task 2: Recompose create and join task pages

**Files:**
- Modify: `apps/web/src/pages/create-meeting-page.tsx`
- Modify: `apps/web/src/pages/join-lobby-page.tsx`
- Modify: `apps/web/src/components/device-check.tsx`
- Modify: `apps/web/src/components/current-meeting-card.tsx`
- Modify: `apps/web/src/i18n/i18n.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/pages/lobby.test.tsx`
- Test: `apps/web/src/accessibility.test.tsx`

**Interfaces:**
- Consumes: `TaskPageLayout` from Task 1 and terminal-link state from the redirect plan.
- Produces: desktop task split and mobile single-column/collapsible device check.

- [ ] **Step 1: Write failing page-structure tests**

```tsx
it('places create context and form in the task layout', async () => {
  installBrowserFakes();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({ meeting: null })));
  renderAt('/create');

  expect(await screen.findByRole('complementary')).toHaveTextContent('private');
  expect(screen.getByRole('form', { name: 'Create meeting' })).toBeVisible();
});

it('keeps device check secondary to the join form', async () => {
  installBrowserFakes();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({
    name: 'Design review', status: 'created', requiresPassword: false, isFull: false
  })));
  renderAt(`/m/${slug}`);

  expect(await screen.findByRole('form', { name: 'Join meeting' })).toBeVisible();
  expect(screen.getByRole('group', { name: 'Device check' })).toBeVisible();
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
pnpm --filter @meeting/web test -- apps/web/src/pages/lobby.test.tsx apps/web/src/accessibility.test.tsx -t "task layout|device check secondary"
```

- [ ] **Step 3: Implement semantic layout without changing form logic**

Wrap both pages in `TaskPageLayout`. Add explicit `aria-label` to forms. Put `CurrentMeetingCard` and security copy in `context`. Render `DeviceCheck` in a `<details className="device-check-disclosure">` on mobile through CSS while keeping it open/visible on desktop.

- [ ] **Step 4: Add responsive task-page CSS**

Use:

```css
.task-page { display:grid; grid-template-columns:minmax(0,.8fr) minmax(28rem,1.2fr); max-width:70rem; }
@media (max-width: 44.999rem) {
  .task-page { grid-template-columns:minmax(0,1fr); }
  .task-surface { padding:1rem; }
}
```

Do not use a page-sized card shadow; sections are separated by spacing, typography, and one divider.

- [ ] **Step 5: Run page tests and accessibility suite**

```powershell
pnpm --filter @meeting/web test -- apps/web/src/pages/lobby.test.tsx apps/web/src/accessibility.test.tsx
```

- [ ] **Step 6: Commit**

```powershell
git add apps/web/src/pages/create-meeting-page.tsx apps/web/src/pages/join-lobby-page.tsx apps/web/src/components/device-check.tsx apps/web/src/components/current-meeting-card.tsx apps/web/src/i18n/i18n.tsx apps/web/src/styles.css apps/web/src/pages/lobby.test.tsx apps/web/src/accessibility.test.tsx
git commit -m "feat(web): recompose meeting task pages"
```

---

### Task 3: Preserve source aspect ratio in `ScreenStage`

**Files:**
- Modify: `apps/web/src/components/screen-stage.tsx`
- Modify: `apps/web/src/components/screen-stage.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `sourceAspectRatio: number`, `data-orientation="landscape|portrait"`, CSS custom property `--stage-aspect-ratio`.
- Consumes: visible video metadata after P2P/LiveKit source commit.

- [ ] **Step 1: Write failing aspect-ratio tests**

```tsx
it.each([
  [1920, 1080, '1.7777777777777777', 'landscape'],
  [1920, 1200, '1.6', 'landscape'],
  [1024, 768, '1.3333333333333333', 'landscape'],
  [1080, 1920, '0.5625', 'portrait']
] as const)('uses source metadata %sx%s for stage ratio', (width, height, ratio, orientation) => {
  const { container } = render(<ScreenStage stream={makeStream()} muted={false} />);
  const video = getVisibleVideo(container);
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: width });
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: height });
  fireEvent.loadedMetadata(video);

  const stage = screen.getByRole('region', { name: 'Shared screen stage' });
  expect(stage).toHaveStyle({ '--stage-aspect-ratio': ratio });
  expect(stage).toHaveAttribute('data-orientation', orientation);
  expect(video).toHaveStyle({ objectFit: 'contain' });
});
```

- [ ] **Step 2: Run test and verify RED**

```powershell
pnpm --filter @meeting/web test -- apps/web/src/components/screen-stage.test.tsx -t "uses source metadata"
```

- [ ] **Step 3: Implement metadata-driven ratio**

```tsx
const [sourceAspectRatio, setSourceAspectRatio] = useState(16 / 9);
const updateAspectRatio = useCallback(() => {
  const video = videoRef.current;
  if (!video?.videoWidth || !video.videoHeight) return;
  setSourceAspectRatio(video.videoWidth / video.videoHeight);
}, []);
```

Call after `loadedmetadata`, `resize`, and source commit. Apply the CSS property to the stage. Keep `object-fit: contain` and existing fullscreen behavior.

- [ ] **Step 4: Preserve the old ratio through handover**

Extend the dual-source test: old ratio remains while the probe stages the new source; firing the new metadata/playing commit updates the ratio once.

- [ ] **Step 5: Run all ScreenStage tests**

```powershell
pnpm --filter @meeting/web test -- apps/web/src/components/screen-stage.test.tsx
```

- [ ] **Step 6: Commit**

```powershell
git add apps/web/src/components/screen-stage.tsx apps/web/src/components/screen-stage.test.tsx apps/web/src/styles.css
git commit -m "feat(web): preserve shared source aspect ratio"
```

---

### Task 4: Build meeting top bar, drawer, and low-frequency menu

**Files:**
- Create: `apps/web/src/components/meeting-top-bar.tsx`
- Create: `apps/web/src/components/meeting-drawer.tsx`
- Create: `apps/web/src/components/meeting-menu.tsx`
- Create: `apps/web/src/components/meeting-workspace.test.tsx`
- Modify: `apps/web/src/i18n/i18n.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `MeetingPanel = 'participants' | 'settings' | 'stats' | 'more' | null`.
- Produces: `MeetingDrawer({ panel, title, onClose, onBack?, children })`.
- Produces: `MeetingTopBar({ title, transport, participantCount, onParticipants, onSettings })`.

- [ ] **Step 1: Write failing drawer interaction tests**

```tsx
it('opens one labelled meeting drawer and returns focus on close', async () => {
  const onClose = vi.fn();
  const trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  render(<MeetingDrawer panel="participants" title="Participants" onClose={onClose} returnFocusRef={{ current: trigger }}>
    <p>Ada</p>
  </MeetingDrawer>);

  expect(screen.getByRole('dialog', { name: 'Participants' })).toBeVisible();
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run test and verify RED**

```powershell
pnpm --filter @meeting/web test -- apps/web/src/components/meeting-workspace.test.tsx
```

- [ ] **Step 3: Implement reusable responsive drawer semantics**

Use one `role="dialog"`, `aria-modal` on mobile, an explicit heading, close button with `X` icon, Escape listener, and focus return. CSS makes it a side drawer above `64rem` and bottom sheet below `45rem`.

- [ ] **Step 4: Implement top bar and menu rows**

`MeetingMenu` rows use lucide icons and expose:

```ts
type MeetingMenuAction = 'participants' | 'audio-devices' | 'screen-settings' | 'webrtc-stats' | 'leave';
```

The leave row is visually dangerous. `webrtc-stats` is present but secondary.

- [ ] **Step 5: Run component tests and typecheck**

```powershell
pnpm --filter @meeting/web test -- apps/web/src/components/meeting-workspace.test.tsx
pnpm --filter @meeting/web typecheck
```

- [ ] **Step 6: Commit**

```powershell
git add apps/web/src/components/meeting-top-bar.tsx apps/web/src/components/meeting-drawer.tsx apps/web/src/components/meeting-menu.tsx apps/web/src/components/meeting-workspace.test.tsx apps/web/src/i18n/i18n.tsx apps/web/src/styles.css
git commit -m "feat(web): add responsive meeting navigation"
```

---

### Task 5: Recompose the meeting room and primary control dock

**Files:**
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Modify: `apps/web/src/components/meeting-controls.tsx`
- Modify: `apps/web/src/components/participant-list.tsx`
- Modify: `apps/web/src/components/host-menu.tsx`
- Modify: `apps/web/src/meeting/room.test.tsx`
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `MeetingTopBar`, `MeetingDrawer`, `MeetingMenu`, `MeetingPanel`.
- Produces: primary dock callbacks unchanged for controllers; settings content rendered in drawers.

- [ ] **Step 1: Write failing meeting-workspace integration tests**

```tsx
it('keeps primary controls in the dock and advanced controls in settings', async () => {
  renderRoom();
  const dock = await screen.findByRole('toolbar', { name: 'Primary meeting controls' });
  expect(within(dock).getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
  expect(within(dock).getByRole('button', { name: 'Share screen' })).toBeVisible();
  expect(within(dock).getByRole('button', { name: 'More' })).toBeVisible();
  expect(screen.queryByLabelText('Screen-share codec')).not.toBeInTheDocument();

  await userEvent.click(within(dock).getByRole('button', { name: 'More' }));
  await userEvent.click(screen.getByRole('button', { name: 'Screen sharing settings' }));
  expect(screen.getByLabelText('Screen-share codec')).toBeVisible();
});
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
pnpm --filter @meeting/web test -- apps/web/src/meeting/room.test.tsx apps/web/src/meeting/screen-share.test.tsx -t "primary controls|advanced controls"
```

- [ ] **Step 3: Add panel state without touching controllers**

```tsx
const [meetingPanel, setMeetingPanel] = useState<MeetingPanel>(null);
```

Compose top bar, stage, drawer, and dock. Reuse every existing callback (`setMicrophoneEnabled`, `toggleScreenShare`, device changes, volume changes, transport preference, leave) exactly once.

- [ ] **Step 4: Split `MeetingControls` into primary dock and settings sections**

Keep exported `MeetingControls` as the dock for compatibility. Export focused `AudioDeviceSettings` and `ScreenShareSettings` sections or move them to the drawer page composition. Do not duplicate form controls.

- [ ] **Step 5: Integrate participant and host actions into the participant drawer**

Preserve all host authorization, grant/revoke, kick, and end callbacks. On mobile, member administration expands below the selected member row.

- [ ] **Step 6: Run meeting tests**

```powershell
pnpm --filter @meeting/web test -- apps/web/src/meeting/room.test.tsx apps/web/src/meeting/screen-share.test.tsx apps/web/src/accessibility.test.tsx
```

- [ ] **Step 7: Commit**

```powershell
git add apps/web/src/pages/meeting-room-page.tsx apps/web/src/components/meeting-controls.tsx apps/web/src/components/participant-list.tsx apps/web/src/components/host-menu.tsx apps/web/src/meeting/room.test.tsx apps/web/src/meeting/screen-share.test.tsx apps/web/src/styles.css
git commit -m "feat(web): recompose the meeting workspace"
```

---

### Task 6: Move WebRTC data into the diagnostic drawer

**Files:**
- Modify: `apps/web/src/components/webrtc-stats-panel.tsx`
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: existing `WebRtcStatsSnapshot`, requested codec, transport mode.
- Produces: `WebRtcStatsPanel({ snapshot, requestedCodec, mode, embedded?: boolean })`.

- [ ] **Step 1: Write failing diagnostic-entry tests**

```tsx
it('keeps WebRTC data behind the low-frequency diagnostics entry', async () => {
  renderP2pRoom({
    createSignalingClient: fakeSignalingClient().factory,
    shareControllerFactory: fakeShareControllerFactory
  });
  expect(screen.queryByText('WebRTC statistics')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'More' }));
  await userEvent.click(screen.getByRole('button', { name: 'WebRTC data' }));
  expect(screen.getByRole('dialog', { name: 'WebRTC data' })).toBeVisible();
  expect(screen.getByText('WebRTC statistics')).toBeVisible();
});
```

- [ ] **Step 2: Run test and verify RED**

Run the named test in `screen-share.test.tsx`.

- [ ] **Step 3: Add embedded stats mode**

In embedded mode remove absolute positioning and render the existing summary/grid as drawer content. Keep the stats polling effect in `MeetingRoomPage` unchanged so opening the drawer never restarts media or sampling.

- [ ] **Step 4: Run all stats and screen-share tests**

```powershell
pnpm --filter @meeting/web test -- apps/web/src/meeting/webrtc-stats.test.tsx apps/web/src/meeting/screen-share.test.tsx
```

- [ ] **Step 5: Commit**

```powershell
git add apps/web/src/components/webrtc-stats-panel.tsx apps/web/src/pages/meeting-room-page.tsx apps/web/src/meeting/screen-share.test.tsx apps/web/src/styles.css
git commit -m "feat(web): move WebRTC stats into diagnostics"
```

---

### Task 7: Finish responsive styling and visual QA

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/accessibility.test.tsx`
- Modify: `apps/web/e2e/create-join.spec.ts`
- Modify: `apps/web/e2e/host-controls.spec.ts`
- Modify: `docs/05-test-and-acceptance.md`

**Interfaces:**
- Consumes: all completed layout components.
- Produces: approved desktop/mobile rendering and acceptance coverage.

- [ ] **Step 1: Add breakpoint and overflow assertions**

Add E2E checks at `1440×900`, `390×844`, and `320×568`:

```ts
await page.setViewportSize({ width: 390, height: 844 });
await expect(page.getByRole('toolbar', { name: 'Primary meeting controls' })).toBeVisible();
expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
```

- [ ] **Step 2: Implement final CSS against approved targets**

Use CSS custom properties for surfaces, spacing, drawer width, dock height, and stage ratio. Desktop drawers are `min(22rem, 30vw)`; mobile sheets use `max-height: min(72vh, 38rem)` and safe-area bottom padding. Keep stage and fullscreen behavior functional at every breakpoint.

- [ ] **Step 3: Start the local E2E origin and capture reference-sized screenshots**

Run the existing local E2E server with required test TURN environment values, then capture create, valid join, active meeting, open More, open diagnostics, and participant drawer at the four required viewport sizes.

- [ ] **Step 4: Compare implementation and visual targets together**

Provide the approved desktop/mobile images and implementation screenshots in one comparison input. Fix visible hierarchy, spacing, cropping, target-size, and contrast differences. Repeat until no material mismatch remains.

- [ ] **Step 5: Run complete verification**

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
& 'C:\Program Files\Git\bin\bash.exe' scripts/http-headers.test.sh
& 'C:\Program Files\Git\bin\bash.exe' scripts/deployment-smoke.test.sh
& 'C:\Program Files\Git\bin\bash.exe' scripts/deployment-scripts.test.sh
git diff --check
```

Expected: every command exits 0. The existing Vite chunk-size warning is acceptable.

- [ ] **Step 6: Commit visual QA and acceptance updates**

```powershell
git add apps/web/src/styles.css apps/web/src/accessibility.test.tsx apps/web/e2e/create-join.spec.ts apps/web/e2e/host-controls.spec.ts docs/05-test-and-acceptance.md
git commit -m "test(web): verify responsive meeting workspace"
```

---

### Task 8: Push and Web-only deploy

**Files:**
- Verify/deploy only.

**Interfaces:**
- Consumes: clean verified branch.
- Produces: GitHub branch and production Web hotfix record.

- [ ] **Step 1: Push the feature branch**

```powershell
git push origin codex/receiver-audio-volume
git rev-parse HEAD
git ls-remote origin refs/heads/codex/receiver-audio-volume
```

Expected: local and remote SHA match.

- [ ] **Step 2: Build and checksum immutable Web artifact**

Build `apps/web/dist`, archive it, and record SHA-256 plus byte size.

- [ ] **Step 3: Deploy only Web**

Use the existing Aliyun Workbench terminal and current verified Web image as the base. Build with `--network=none`; create a release-specific Web override; run:

```bash
docker compose \
  --env-file infra/.env.production \
  -f infra/docker-compose.yml \
  -f "$BASE_OVERRIDE" \
  -f "$HOTFIX_OVERRIDE" \
  up -d --no-deps --no-build --pull never web
```

Record API, Caddy, LiveKit, and coturn container IDs before and after and require exact equality.

- [ ] **Step 4: Verify public artifact and routes**

- All five services healthy.
- Public index hash equals container `/srv/index.html`.
- Public JS contains the new menu/redirect copy and asset hash.
- Missing and ended meeting URLs finish on `/create`.
- Fullscreen and WebRTC data entries are present in the built UI.
- Write a mode-600 Web-hotfix record with previous/new Web image tags and IDs.
