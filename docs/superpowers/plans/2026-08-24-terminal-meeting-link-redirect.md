# Terminal Meeting Link Redirect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent nonexistent, ended, or expired meeting links from rendering an actionable lobby and replace-navigate those links to `/create` while preserving retry behavior for transient failures.

**Architecture:** `JoinLobbyPage` owns an explicit lobby-summary state machine instead of overloading `undefined`. A small pure classifier maps terminal summaries and API errors to redirect decisions; transient lookup failures render a retry state. The backend API and contracts remain unchanged.

**Tech Stack:** React 19, React Router 7, TypeScript, TypeBox contracts, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-24-responsive-meeting-ui-and-terminal-links-design.md`

## Global Constraints

- Summary statuses `ended` and `expired` replace-navigate to `/create`.
- API codes `MEETING_NOT_FOUND`, `MEETING_EXPIRED`, HTTP 404, and HTTP 410 replace-navigate to `/create`.
- HTTP 429, 5xx, network failures, and malformed responses remain on the lobby and expose retry.
- The join form and device check are not rendered until a valid nonterminal summary is loaded.
- Terminal join failures stop any active device preview before navigation.
- No API, database, or contract changes.

---

### Task 1: Add the lobby summary state machine

**Files:**
- Modify: `apps/web/src/pages/join-lobby-page.tsx`
- Test: `apps/web/src/pages/lobby.test.tsx`

**Interfaces:**
- Consumes: `MeetingSummary`, `ApiRequestError`, `useNavigate()`.
- Produces: local `LobbySummaryState` and `isTerminalMeetingFailure(reason: unknown): boolean`.

- [ ] **Step 1: Write failing tests for loading and terminal summaries**

Add tests under `describe('join lobby')`:

```tsx
it('does not expose the join form before the meeting summary is validated', () => {
  installBrowserFakes();
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
  renderAt(`/m/${slug}`);

  expect(screen.getByRole('status')).toHaveTextContent('Checking meeting');
  expect(screen.queryByLabelText('Nickname')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Join muted' })).not.toBeInTheDocument();
});

it.each(['ended', 'expired'] as const)('redirects a %s meeting summary to create', async (status) => {
  installBrowserFakes();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({
    name: 'Old meeting', status, requiresPassword: false, isFull: false
  })));
  renderAt(`/meetings/${slug}`);

  expect(await screen.findByRole('heading', { name: 'Create a meeting' })).toBeVisible();
  expect(screen.queryByLabelText('Nickname')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
pnpm --filter @meeting/web test -- apps/web/src/pages/lobby.test.tsx -t "before the meeting summary|meeting summary to create"
```

Expected: loading test finds the existing join form; terminal summaries remain on the lobby.

- [ ] **Step 3: Implement explicit lobby-summary state**

Add:

```tsx
type LobbySummaryState =
  | { kind: 'loading' }
  | { kind: 'ready'; summary: MeetingSummary }
  | { kind: 'unavailable' };

function terminalSummary(summary: MeetingSummary): boolean {
  return summary.status === 'ended' || summary.status === 'expired';
}
```

Replace `summary` state with:

```tsx
const [summaryState, setSummaryState] = useState<LobbySummaryState>({ kind: 'loading' });
const passwordRequired = summaryState.kind === 'ready' && summaryState.summary.requiresPassword;
```

Extract a `loadSummary` callback that sets `loading`, requests the summary, replace-navigates terminal summaries, and stores only nonterminal summaries. Render a `role="status"` loading surface before the existing form.

- [ ] **Step 4: Run the targeted tests and verify GREEN**

Run the Step 2 command.

Expected: both tests pass.

- [ ] **Step 5: Commit the state-machine slice**

```powershell
git add apps/web/src/pages/join-lobby-page.tsx apps/web/src/pages/lobby.test.tsx
git commit -m "fix(web): gate lobby on meeting summary"
```

---

### Task 2: Classify terminal lookup errors and retry transient failures

**Files:**
- Modify: `apps/web/src/pages/join-lobby-page.tsx`
- Modify: `apps/web/src/i18n/i18n.tsx`
- Test: `apps/web/src/pages/lobby.test.tsx`

**Interfaces:**
- Consumes: `ApiRequestError.status`, `ApiRequestError.details?.error.code`.
- Produces: `isTerminalMeetingFailure(reason)` and retry copy keys `join.loading`, `join.lookupFailed`, `join.retry`.

- [ ] **Step 1: Write failing redirect and retry tests**

```tsx
it.each([
  ['MEETING_NOT_FOUND', 404],
  ['MEETING_EXPIRED', 410]
] as const)('redirects terminal lookup error %s to create', async (code, status) => {
  installBrowserFakes();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({
    error: { code, message: 'Terminal', correlationId: 'corr-terminal' }
  }, status)));
  renderAt(`/m/${slug}`);

  expect(await screen.findByRole('heading', { name: 'Create a meeting' })).toBeVisible();
});

it('keeps a transient lookup failure in the lobby and retries', async () => {
  installBrowserFakes();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(success({
      error: { code: 'MEDIA_SERVICE_UNAVAILABLE', message: 'Unavailable', correlationId: 'corr-503' }
    }, 503))
    .mockResolvedValueOnce(success({
      name: 'Daily', status: 'created', requiresPassword: false, isFull: false
    }));
  vi.stubGlobal('fetch', fetchMock);
  renderAt(`/m/${slug}`);

  expect(await screen.findByRole('alert')).toHaveTextContent('Meeting details could not be loaded');
  expect(screen.queryByLabelText('Nickname')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByLabelText('Nickname')).toBeVisible();
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
pnpm --filter @meeting/web test -- apps/web/src/pages/lobby.test.tsx -t "terminal lookup error|transient lookup failure"
```

Expected: terminal errors render the lobby and transient failures do not expose retry.

- [ ] **Step 3: Implement terminal error classification and retry UI**

```tsx
function isTerminalMeetingFailure(reason: unknown): boolean {
  if (!(reason instanceof ApiRequestError)) return false;
  const code = reason.details?.error.code;
  return reason.status === 404
    || reason.status === 410
    || code === 'MEETING_NOT_FOUND'
    || code === 'MEETING_EXPIRED';
}
```

In the summary catch branch, navigate on terminal failures and set `{ kind: 'unavailable' }` otherwise. Render the unavailable state with `role="alert"` and a retry button that calls `loadSummary()`.

Add English and Simplified Chinese messages for loading, lookup failure, and retry.

- [ ] **Step 4: Run the targeted tests and verify GREEN**

Run the Step 2 command.

Expected: all cases pass without console warnings.

- [ ] **Step 5: Commit the error-classification slice**

```powershell
git add apps/web/src/pages/join-lobby-page.tsx apps/web/src/pages/lobby.test.tsx apps/web/src/i18n/i18n.tsx
git commit -m "fix(web): redirect terminal meeting links"
```

---

### Task 3: Redirect terminal join failures and verify routing history

**Files:**
- Modify: `apps/web/src/pages/join-lobby-page.tsx`
- Test: `apps/web/src/pages/lobby.test.tsx`
- Test: `apps/web/src/pages/join-room.integration.test.tsx`

**Interfaces:**
- Consumes: `isTerminalMeetingFailure`, `previewCleanup`, React Router replace navigation.
- Produces: terminal join failure cleanup + `/create` routing.

- [ ] **Step 1: Write the failing terminal-join test**

```tsx
it('stops device preview and redirects when the meeting ends before join completes', async () => {
  const { track } = installBrowserFakes();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/join')
    ? success({
        error: { code: 'MEETING_EXPIRED', message: 'Ended', correlationId: 'corr-ended' }
      }, 410)
    : success({ name: 'Daily', status: 'active', requiresPassword: false, isFull: false }));
  vi.stubGlobal('fetch', fetchMock);
  renderAt(`/m/${slug}`);

  await screen.findByLabelText('Nickname');
  await userEvent.click(screen.getByRole('button', { name: 'Check microphone' }));
  await userEvent.type(screen.getByLabelText('Nickname'), 'Ada');
  await userEvent.click(screen.getByRole('button', { name: 'Join muted' }));

  expect(await screen.findByRole('heading', { name: 'Create a meeting' })).toBeVisible();
  expect(track.stop).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the test and verify RED**

```powershell
pnpm --filter @meeting/web test -- apps/web/src/pages/lobby.test.tsx -t "ends before join completes"
```

Expected: lobby displays the API error instead of routing.

- [ ] **Step 3: Implement terminal join handling**

In the join catch branch:

```tsx
if (isTerminalMeetingFailure(reason)) {
  previewCleanup?.();
  navigate('/create', { replace: true });
  return;
}
```

Keep existing error text for every nonterminal join error.

- [ ] **Step 4: Run lobby and router integration suites**

```powershell
pnpm --filter @meeting/web test -- apps/web/src/pages/lobby.test.tsx apps/web/src/pages/join-room.integration.test.tsx
```

Expected: all lobby and room-routing tests pass.

- [ ] **Step 5: Commit the terminal-join slice**

```powershell
git add apps/web/src/pages/join-lobby-page.tsx apps/web/src/pages/lobby.test.tsx apps/web/src/pages/join-room.integration.test.tsx
git commit -m "fix(web): leave terminal join links"
```

---

### Task 4: Run complete verification

**Files:**
- Verify only.

**Interfaces:**
- Consumes: completed lobby state machine.
- Produces: a green baseline for the UI redesign plan.

- [ ] **Step 1: Run all automated gates**

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Expected: all commands exit 0; the existing Vite chunk-size warning is acceptable.

- [ ] **Step 2: Run the invalid-link production-shaped acceptance**

Use the local integration tests to open `/meetings/abcdefghijklmnopqrstuv` and assert the final location is `/create` with no nickname field ever becoming interactive.

- [ ] **Step 3: Record completion**

```powershell
git status --short --branch
```

Expected: no tracked changes remain; unrelated pre-existing untracked files are untouched.
