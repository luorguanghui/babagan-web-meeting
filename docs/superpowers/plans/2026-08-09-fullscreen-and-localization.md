# Fullscreen and Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the oversized persistent fullscreen button with a compact icon that disappears in fullscreen, and provide a complete Simplified Chinese/English interface that follows the browser language and remembers manual selection.

**Architecture:** Add a dependency-free React localization provider with typed message keys, persisted locale resolution, and one global selector. Route every user-facing web string through that provider without changing meeting or media state. Keep fullscreen behavior inside `ScreenStage`, using a translated SVG icon control plus `fullscreenchange` state and CSS hiding.

**Tech Stack:** React 19, TypeScript 5.9, React Router 7, Vitest 4, Testing Library, CSS, browser Fullscreen API, `localStorage`.

## Global Constraints

- Supported locales are exactly `zh-CN` and `en`.
- Locale priority is valid persisted choice, then any `navigator.languages` entry beginning with `zh`, then `en`.
- Manual selection persists when storage is available; storage failures must not block in-session switching.
- Every locale change updates `document.documentElement.lang`.
- Do not add a third-party internationalization dependency.
- Language changes must not reconnect LiveKit, recreate media tracks, or reset page inputs.
- Localize visible text, `aria-label`, `title`, status text, confirmation prompts, and known API errors.
- Keep the current WebRTC behavior, 13 Mbps high-motion profile, playout delay, and server architecture unchanged.
- The fullscreen control is an approximately 36 × 36 pixel SVG icon button and is absent while the shared stage is fullscreen.
- Use TDD for every behavior change: write the test, run it and observe the intended failure, implement the minimum behavior, and rerun the focused test.

---

### Task 1: Locale resolution, provider, and global selector

**Files:**
- Create: `apps/web/src/i18n/messages.ts`
- Create: `apps/web/src/i18n/i18n.tsx`
- Create: `apps/web/src/i18n/i18n.test.tsx`
- Create: `apps/web/src/components/language-selector.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `type Locale = 'en' | 'zh-CN'`.
- Produces: `type Translate = (key: MessageKey, params?: MessageParams) => string`.
- Produces: `LanguageProvider`, `useI18n(): { locale: Locale; setLocale(locale: Locale): void; t(key: MessageKey, params?: MessageParams): string }`.
- Produces: `resolveInitialLocale(storage, languages): Locale` with key `babagan.locale`.
- Produces: `LanguageSelector`, rendered once by `App` and available on every route.

- [ ] **Step 1: Write failing locale behavior tests**

Create `apps/web/src/i18n/i18n.test.tsx` with real provider/selector behavior:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageSelector } from '../components/language-selector.js';
import { LanguageProvider, resolveInitialLocale, useI18n } from './i18n.js';

function Probe() {
  const { locale, t } = useI18n();
  return <><output>{locale}</output><span>{t('language.label')}</span><LanguageSelector /></>;
}

afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

describe('localization', () => {
  it('uses Chinese when a preferred browser language begins with zh', () => {
    expect(resolveInitialLocale(window.localStorage, ['fr-FR', 'zh-HK'])).toBe('zh-CN');
  });

  it('prefers a valid persisted locale over browser languages', () => {
    window.localStorage.setItem('babagan.locale', 'en');
    expect(resolveInitialLocale(window.localStorage, ['zh-CN'])).toBe('en');
  });

  it('switches language, persists it, and updates the document language', async () => {
    render(<LanguageProvider initialLocale="en"><Probe /></LanguageProvider>);
    await userEvent.selectOptions(screen.getByLabelText('Language'), 'zh-CN');
    expect(screen.getByText('语言')).toBeVisible();
    expect(window.localStorage.getItem('babagan.locale')).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('keeps switching in memory when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked'); });
    render(<LanguageProvider initialLocale="en"><Probe /></LanguageProvider>);
    await userEvent.selectOptions(screen.getByLabelText('Language'), 'zh-CN');
    expect(screen.getByText('语言')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the locale tests and verify RED**

Run:

```powershell
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/i18n/i18n.test.tsx
```

Expected: FAIL because `i18n/i18n.tsx` and `LanguageSelector` do not exist.

- [ ] **Step 3: Implement typed messages and locale state**

Create `messages.ts` with strings and parameterized values under stable keys. Use this exact shape so later tasks share one contract:

```ts
export type MessageParams = Record<string, string | number>;
type MessageValue = string | ((params: MessageParams) => string);

export const en = {
  'language.label': 'Language',
  'language.english': 'English',
  'language.chinese': 'Simplified Chinese'
} satisfies Record<string, MessageValue>;

export type MessageKey = keyof typeof en;

export const zhCN: Record<MessageKey, MessageValue> = {
  'language.label': '语言',
  'language.english': 'English',
  'language.chinese': '简体中文'
};
```

Create `i18n.tsx` with safe storage reads/writes, browser-language resolution, `useState`, `useEffect` for `<html lang>`, and a context guard that throws only when a component is rendered outside `LanguageProvider`.

```tsx
export type Locale = 'en' | 'zh-CN';
export const localeStorageKey = 'babagan.locale';

export function resolveInitialLocale(storage: Pick<Storage, 'getItem'> | undefined, languages: readonly string[]): Locale {
  try {
    const saved = storage?.getItem(localeStorageKey);
    if (saved === 'en' || saved === 'zh-CN') return saved;
  } catch { /* fall through to browser preference */ }
  return languages.some((language) => language.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en';
}
```

The provider's optional `initialLocale` is a test seam; production resolves from `window.localStorage` and `navigator.languages` once during initialization. `setLocale` updates React state even if `localStorage.setItem` throws.

- [ ] **Step 4: Implement and place the global selector**

Create `LanguageSelector` as a labeled select:

```tsx
export function LanguageSelector() {
  const { locale, setLocale, t } = useI18n();
  return <label className="language-selector">
    <span>{t('language.label')}</span>
    <select aria-label={t('language.label')} value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
      <option value="zh-CN">{t('language.chinese')}</option>
      <option value="en">{t('language.english')}</option>
    </select>
  </label>;
}
```

Wrap `BrowserRouter` and `App` in `LanguageProvider` in `main.tsx`. Render `LanguageSelector` once in `App` before `MeetingErrorBoundary`; use a `.app-language` container positioned at the top-right of the normal page flow, with mobile wrapping and no fixed overlay.

- [ ] **Step 5: Run focused tests and commit Task 1**

Run:

```powershell
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/i18n/i18n.test.tsx
pnpm typecheck
```

Expected: all locale tests pass and TypeScript exits 0.

Commit:

```powershell
git add apps/web/src/i18n apps/web/src/components/language-selector.tsx apps/web/src/main.tsx apps/web/src/app.tsx apps/web/src/styles.css
git commit -m "Add browser-aware language selection"
```

---

### Task 2: Localize create, join, device-check, and application errors

**Files:**
- Modify: `apps/web/src/i18n/messages.ts`
- Create: `apps/web/src/i18n/api-errors.ts`
- Modify: `apps/web/src/pages/create-meeting-page.tsx`
- Modify: `apps/web/src/pages/join-lobby-page.tsx`
- Modify: `apps/web/src/components/device-check.tsx`
- Modify: `apps/web/src/components/error-boundary.tsx`
- Modify: `apps/web/src/pages/lobby.test.tsx`
- Modify: `apps/web/src/pages/join-room.integration.test.tsx`
- Modify: `apps/web/src/accessibility.test.tsx`

**Interfaces:**
- Consumes: `useI18n`, `MessageKey`, and `t` from Task 1.
- Produces: `localizeApiError(error: ApiRequestError, t: Translate, fallback: MessageKey): string`.
- Produces: complete public-flow message groups `create.*`, `lobby.*`, `device.*`, `error.*`, and `api.*` in both catalogues.

- [ ] **Step 1: Add failing Chinese public-flow tests**

Extend `lobby.test.tsx` with a helper that selects Chinese through the real global selector and add these observable assertions:

```tsx
async function switchToChinese() {
  await userEvent.selectOptions(screen.getByLabelText('Language'), 'zh-CN');
}

it('localizes the create form and validation in Chinese', async () => {
  installBrowserFakes();
  renderAt('/create');
  await switchToChinese();
  expect(screen.getByRole('heading', { name: '创建会议' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '创建会议' }));
  expect(screen.getByRole('alert')).toHaveTextContent('请输入会议名称');
});

it('localizes the join lobby and device check in Chinese', async () => {
  installBrowserFakes();
  renderAt(`/m/${slug}`);
  await switchToChinese();
  expect(screen.getByRole('heading', { name: '准备加入会议' })).toBeVisible();
  expect(screen.getByRole('button', { name: '检查麦克风' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '静音加入' })).toBeEnabled();
});

it('maps known API error codes instead of showing English server text in Chinese', async () => {
  installBrowserFakes();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({
    error: { code: 'ADMIN_AUTH_FAILED', message: 'Authentication failed', correlationId: 'corr-123' }
  }, 401)));
  renderAt('/create');
  await switchToChinese();
  await userEvent.type(screen.getByLabelText('会议名称'), '设计评审');
  await userEvent.type(screen.getByLabelText('管理员密码'), 'host-secret');
  await userEvent.click(screen.getByRole('button', { name: '创建会议' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('管理员身份验证失败');
  expect(screen.getByRole('alert')).not.toHaveTextContent('Authentication failed');
});
```

Add a Chinese error-boundary test in `accessibility.test.tsx` that renders the boundary inside `LanguageProvider initialLocale="zh-CN"` and expects `支持编号：corr-123`.

- [ ] **Step 2: Run public-flow tests and verify RED**

Run:

```powershell
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/pages/lobby.test.tsx apps/web/src/accessibility.test.tsx
```

Expected: FAIL because the pages still render English and known API errors expose server text.

- [ ] **Step 3: Add complete public-flow catalogue keys**

Add matching English and Chinese keys for:

```ts
'create.eyebrow', 'create.title', 'create.description', 'create.meetingName',
'create.adminPassword', 'create.meetingPassword', 'create.optional', 'create.submit',
'create.submitting', 'create.nameRequired', 'create.adminRequired', 'create.passwordLength',
'create.failed', 'create.copyManual', 'create.linkLabel', 'create.shareLink',
'create.enterHost', 'create.copyLink', 'create.linkCopied',
'lobby.eyebrow', 'lobby.title', 'lobby.description', 'lobby.nickname',
'lobby.meetingPassword', 'lobby.ifRequired', 'lobby.submit', 'lobby.submitting',
'lobby.nicknameRequired', 'lobby.joinFailed', 'lobby.httpsRequired',
'lobby.webRtcUnavailable', 'lobby.mobileLimited', 'lobby.unsupportedDesktop',
'device.title', 'device.description', 'device.checkMicrophone', 'device.testSpeaker',
'device.microphoneLevel', 'device.off', 'device.policyBlocked', 'device.previewReady',
'device.permissionDenied', 'device.previewFailed', 'device.speakerUnavailable',
'device.playingSpeakerTest', 'error.title', 'error.returnAndRetry', 'error.supportId',
'api.meetingNotFound', 'api.meetingExpired', 'api.meetingFull',
'api.invalidMeetingPassword', 'api.adminAuthFailed', 'api.shareAlreadyActive',
'api.shareNotAuthorized', 'api.unsupportedClient', 'api.rateLimited',
'api.mediaUnavailable', 'api.requestFailed'
```

Use natural Chinese copy with the exact tested phrases. Keep all current English text as the `en` values so existing English tests remain meaningful.

- [ ] **Step 4: Implement known API error localization**

Create `api-errors.ts` with an exhaustive mapping for the ten public contract codes:

```ts
const apiErrorKeys = {
  MEETING_NOT_FOUND: 'api.meetingNotFound',
  MEETING_EXPIRED: 'api.meetingExpired',
  MEETING_FULL: 'api.meetingFull',
  INVALID_MEETING_PASSWORD: 'api.invalidMeetingPassword',
  ADMIN_AUTH_FAILED: 'api.adminAuthFailed',
  SHARE_ALREADY_ACTIVE: 'api.shareAlreadyActive',
  SHARE_NOT_AUTHORIZED: 'api.shareNotAuthorized',
  UNSUPPORTED_CLIENT: 'api.unsupportedClient',
  RATE_LIMITED: 'api.rateLimited',
  MEDIA_SERVICE_UNAVAILABLE: 'api.mediaUnavailable'
} satisfies Record<ApiErrorCode, MessageKey>;
```

`localizeApiError` translates `error.details?.error.code`; if details are missing it translates the caller-provided fallback. Components keep the correlation ID separately and never expose uncontrolled server prose in Chinese.

- [ ] **Step 5: Replace public-flow literals with translations**

Use `useI18n()` in function components. Change `clientNotice()` to accept `t` so compatibility branches return translated messages. Store device-check message state as `{ key: MessageKey; isError: boolean }` rather than a rendered string, ensuring a live language switch updates the current status without restarting the microphone preview.

Give `MeetingErrorBoundary` a localized functional wrapper that reads `useI18n` and passes `t` into an inner class boundary; this preserves React error-boundary semantics while allowing translated fallback UI.

- [ ] **Step 6: Run focused tests and commit Task 2**

Run:

```powershell
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/pages/lobby.test.tsx apps/web/src/pages/join-room.integration.test.tsx apps/web/src/accessibility.test.tsx
pnpm typecheck
```

Expected: all specified tests pass.

Commit:

```powershell
git add apps/web/src/i18n apps/web/src/pages/create-meeting-page.tsx apps/web/src/pages/join-lobby-page.tsx apps/web/src/components/device-check.tsx apps/web/src/components/error-boundary.tsx apps/web/src/pages/lobby.test.tsx apps/web/src/pages/join-room.integration.test.tsx apps/web/src/accessibility.test.tsx
git commit -m "Localize meeting entry flows"
```

---

### Task 3: Localize meeting room, controls, host actions, and screen-share guidance

**Files:**
- Modify: `apps/web/src/i18n/messages.ts`
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Modify: `apps/web/src/components/connection-banner.tsx`
- Modify: `apps/web/src/components/host-menu.tsx`
- Modify: `apps/web/src/components/meeting-controls.tsx`
- Modify: `apps/web/src/components/participant-list.tsx`
- Modify: `apps/web/src/components/screen-stage.tsx`
- Modify: `apps/web/src/meeting/screen-share.ts`
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/meeting/room.test.tsx`
- Modify: `apps/web/src/accessibility.test.tsx`

**Interfaces:**
- Consumes: `useI18n` and message catalogues from Tasks 1-2.
- Changes: `ScreenShareState.audioGuidance` becomes `audioGuidanceKey?: MessageKey`; controllers publish semantic keys rather than English prose.
- Produces: meeting message groups `meeting.*`, `connection.*`, `controls.*`, `participants.*`, `host.*`, and `screen.*`.

- [ ] **Step 1: Add failing Chinese meeting tests**

Add focused component tests inside the existing test files:

```tsx
it('renders meeting controls and connection recovery in Chinese', () => {
  render(<LanguageProvider initialLocale="zh-CN">
    <ConnectionBanner state={{ kind: 'reconnecting', since: 1 }} online={false} />
    <MeetingControls
      connection="connected" microphoneEnabled={false} audioPlaybackBlocked={false}
      devices={[]} leaving={false} screenShareAuthorized
      onMicrophoneToggle={() => undefined} onMicrophoneDeviceChange={() => undefined}
      onSpeakerDeviceChange={() => undefined} onResumeAudio={() => undefined}
      onLeave={() => undefined} onScreenShareToggle={() => undefined}
    />
  </LanguageProvider>);
  expect(screen.getByText(/当前离线/)).toHaveAttribute('role', 'status');
  expect(screen.getByRole('button', { name: '取消静音' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '共享屏幕' })).toBeEnabled();
});
```

Add a `ScreenShareController` assertion that the no-audio outcome emits `screen.audioNotShared` instead of fixed English. Add a meeting-page integration assertion for the Chinese system-audio decision dialog and its three translated buttons.

- [ ] **Step 2: Run meeting tests and verify RED**

Run:

```powershell
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/meeting/screen-share.test.tsx apps/web/src/meeting/room.test.tsx apps/web/src/accessibility.test.tsx
```

Expected: FAIL because meeting components still contain English and screen-share state carries rendered prose.

- [ ] **Step 3: Add complete meeting catalogue keys**

Add matching values for these key groups:

```ts
'meeting.eyebrow', 'meeting.title', 'meeting.deviceListFailed',
'meeting.leaveNotConfirmed', 'meeting.speakerSwitchUnsupported',
'meeting.screenStartFailed', 'meeting.systemAudioDialogTitle',
'meeting.systemAudioDialogBody', 'meeting.shareWithoutAudio',
'meeting.continueSystemAudio', 'meeting.cancelChooseTab',
'connection.offline', 'connection.connected', 'connection.refreshing',
'connection.reconnecting', 'connection.busy', 'connection.rejoin',
'connection.ended', 'controls.connection', 'controls.microphoneOn',
'controls.microphoneMuted', 'controls.screenOn', 'controls.screenOff',
'controls.mute', 'controls.unmute', 'controls.microphoneDevice',
'controls.selectMicrophone', 'controls.microphoneFallback',
'controls.speakerDevice', 'controls.selectSpeaker', 'controls.speakerFallback',
'controls.resumeAudio', 'controls.screenQuality', 'controls.standardQuality',
'controls.motionQuality', 'controls.shareScreen', 'controls.stopSharing',
'controls.shareNeedsGrant', 'controls.leave', 'controls.leaving',
'participants.title', 'participants.listLabel', 'participants.you',
'participants.microphoneOn', 'participants.muted', 'participants.itemLabel',
'host.title', 'host.actionFailed', 'host.listLabel', 'host.revokeShare',
'host.grantShare', 'host.kick', 'host.end', 'host.confirmEnd',
'screen.stageLabel', 'screen.empty', 'screen.participantFallback',
'screen.sharedBy', 'screen.enterFullscreen', 'screen.audioNotShared',
'screen.videoOnlyEchoProtection', 'screen.unrestrictedEchoRisk',
'screen.cancelledChooseTab'
```

Dynamic keys such as `meeting.title`, `participants.title`, `participants.itemLabel`, `host.grantShare`, and `screen.sharedBy` are catalogue functions that consume named parameters.

- [ ] **Step 4: Localize components without changing media lifecycle**

Call `useI18n()` only at render boundaries. Pass translated strings into confirmation prompts. Keep controller and LiveKit dependencies stable in `useMemo`; do not add `t` to media-controller construction unless it is unavoidable.

Replace screen-share guidance strings with `MessageKey` values:

```ts
const audioGuidanceKeys = {
  noAudio: 'screen.audioNotShared',
  videoOnly: 'screen.videoOnlyEchoProtection',
  unrestricted: 'screen.unrestrictedEchoRisk',
  tab: 'screen.cancelledChooseTab'
} as const satisfies Record<string, MessageKey>;
```

`MeetingRoomPage` renders `t(screenState.audioGuidanceKey)` so changing language updates the notice without restarting capture.

- [ ] **Step 5: Run focused tests and commit Task 3**

Run:

```powershell
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/meeting/screen-share.test.tsx apps/web/src/meeting/room.test.tsx apps/web/src/accessibility.test.tsx
pnpm typecheck
```

Expected: all specified tests pass with media publication and cleanup assertions unchanged.

Commit:

```powershell
git add apps/web/src/i18n/messages.ts apps/web/src/pages/meeting-room-page.tsx apps/web/src/components/connection-banner.tsx apps/web/src/components/host-menu.tsx apps/web/src/components/meeting-controls.tsx apps/web/src/components/participant-list.tsx apps/web/src/components/screen-stage.tsx apps/web/src/meeting/screen-share.ts apps/web/src/meeting/screen-share.test.tsx apps/web/src/meeting/room.test.tsx apps/web/src/accessibility.test.tsx
git commit -m "Localize meeting room controls"
```

---

### Task 4: Compact graphical fullscreen control that disappears in fullscreen

**Files:**
- Modify: `apps/web/src/components/screen-stage.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/meeting/screen-share.test.tsx`

**Interfaces:**
- Consumes: `t('screen.enterFullscreen')` from Task 3.
- Produces: an icon-only `.screen-stage-fullscreen` button with `aria-label` and `title`.
- Produces: `fullscreenchange` synchronization so the button is not rendered while `document.fullscreenElement === stageRef.current`.

- [ ] **Step 1: Write failing fullscreen behavior tests**

Replace the current text-button assertion with behavior that catches both regressions:

```tsx
it('uses a compact graphical fullscreen control', () => {
  const { stream } = displayStream({ audio: false });
  render(<LanguageProvider initialLocale="en"><ScreenStage stream={stream} sharerName="Ada" /></LanguageProvider>);
  const button = screen.getByRole('button', { name: 'View shared screen fullscreen' });
  expect(button).toHaveClass('screen-stage-fullscreen');
  expect(button.querySelector('svg')).not.toBeNull();
  expect(button).not.toHaveTextContent('Full screen');
});

it('removes the fullscreen button while the stage is fullscreen', async () => {
  const { stream } = displayStream({ audio: false });
  render(<LanguageProvider initialLocale="en"><ScreenStage stream={stream} sharerName="Ada" /></LanguageProvider>);
  const stage = screen.getByLabelText('Shared screen stage');
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: stage });
  document.dispatchEvent(new Event('fullscreenchange'));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'View shared screen fullscreen' })).toBeNull());
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
});
```

Keep the existing `requestFullscreen` invocation test.

- [ ] **Step 2: Run the fullscreen tests and verify RED**

Run:

```powershell
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/meeting/screen-share.test.tsx
```

Expected: FAIL because the button still contains text and remains rendered after `fullscreenchange`.

- [ ] **Step 3: Implement SVG icon and fullscreen state**

In `ScreenStage`, subscribe to `document.fullscreenchange` and derive whether the stage owns fullscreen. Render the button only when not fullscreen. Use an inline decorative SVG with four corner paths and `aria-hidden="true"`; keep the translated name on the button.

```tsx
{!isFullscreen && <button
  type="button"
  className="screen-stage-fullscreen"
  aria-label={t('screen.enterFullscreen')}
  title={t('screen.enterFullscreen')}
  onClick={() => { void stageRef.current?.requestFullscreen().catch(() => undefined); }}
>
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
  </svg>
</button>}
```

Set CSS width/height to `2.25rem`, padding to zero, center the SVG, use an `1.1rem` icon, and retain the current translucent background. Add `.screen-stage:fullscreen .screen-stage-fullscreen { display: none; }` as defense in depth.

- [ ] **Step 4: Run focused tests and commit Task 4**

Run:

```powershell
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/meeting/screen-share.test.tsx
pnpm typecheck
```

Expected: all screen-share tests pass.

Commit:

```powershell
git add apps/web/src/components/screen-stage.tsx apps/web/src/styles.css apps/web/src/meeting/screen-share.test.tsx
git commit -m "Refine shared-screen fullscreen control"
```

---

### Task 5: Full regression, production build, GitHub update, and Web-only deployment

**Files:**
- Verify all files changed in Tasks 1-4.
- Deployment record: `/opt/babagan-web-meeting/var/releases/${revision}.web-hotfix.env` on the server, where `revision=$(git rev-parse --short=7 HEAD)` is captured before packaging.

**Interfaces:**
- Consumes: the completed localization and fullscreen implementation.
- Produces: a clean branch pushed to `origin/codex/web-meeting-implementation` and a healthy Web-only production image.

- [ ] **Step 1: Run the complete verification suite**

Run fresh commands and read their full output:

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
git status --short --branch
```

Expected: zero failed tests, zero type or lint errors, successful Vite build, no whitespace errors, and only intentional changes if a final verification commit remains.

- [ ] **Step 2: Commit any verification-only corrections and push**

If verification required an intentional correction, stage only its named files and commit it with a message describing that correction. Then run:

```powershell
git push origin codex/web-meeting-implementation
git rev-parse HEAD
git ls-remote origin refs/heads/codex/web-meeting-implementation
```

Expected: local HEAD and remote branch SHA are identical.

- [ ] **Step 3: Build and transfer an immutable Web artifact**

Set `revision=$(git rev-parse --short=7 HEAD)` before packaging. Package `apps/web/dist`, calculate its SHA-256 and byte size locally, transfer it to the existing Aliyun terminal in bounded base64 chunks, and verify the same SHA-256 and size on the server before extraction. Build `babagan-meeting-web:release-${revision}` from the current production Web image with `--network=none`; label it with the full revision.

- [ ] **Step 4: Deploy only the Web service**

Create `/opt/babagan-web-meeting/var/releases/${revision}.web-hotfix.override.yml` containing only:

```yaml
services:
  web:
    image: babagan-meeting-web:release-${revision}
```

Record API, LiveKit, and Caddy container IDs. Run Docker Compose with the existing base compose, immutable release override, and new Web override using `up -d --no-deps --no-build --pull never web`. Wait for Web health and assert all three non-Web IDs are unchanged.

- [ ] **Step 5: Verify the public deployment and write the release record**

Fetch `https://meet.babagan.cloud/create`; require its index hash to equal `/srv/index.html`, require the expected Vite JS asset, and require `https://meet.babagan.cloud/health/live` to return 200. Confirm the deployed JS contains the new language-selector and fullscreen accessibility text. Write the hotfix env record with previous/new image tags and IDs, then remove temporary transfer files and return the terminal tab to the user.
