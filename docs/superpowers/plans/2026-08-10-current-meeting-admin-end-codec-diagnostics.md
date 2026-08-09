# Current Meeting, Admin End, Codec Selection, and WebRTC Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publicly expose the one current meeting on `/create`, add password-gated meeting termination outside host sessions, make screen-share codec selectable, and show read-only WebRTC diagnostics.

**Architecture:** Extend the shared TypeBox contracts first, then add narrowly scoped service and HTTP operations. Keep React pages responsible for lifecycle state, place reusable administrator termination and diagnostics UI in focused components, and keep LiveKit/RTC internals behind `MeetingRoomController` plus a pure statistics normalizer.

**Tech Stack:** TypeScript 5.9, TypeBox, Fastify 5, SQLite, React 19, LiveKit Client 2.21, Vitest, Testing Library, Playwright, CSS.

## Global Constraints

- Only one non-terminal meeting may exist; `created`, `active`, and `grace` are non-terminal.
- The public current-meeting response exposes only `slug`, `name`, `status`, `joinUrl`, `requiresPassword`, and `isFull`.
- Administrator-password termination uses five attempts per IP per 15 minutes, creates no host session, and grants no host capability.
- Meeting passwords and administrator passwords must never enter URLs, browser storage, logs, or rendered error details.
- Screen-share codec choices are exactly `h264`, `auto`, and `vp8`; H.264 is the in-memory default.
- Keep 1080p30/1080p60 capture profiles, 60 fps at `10_000_000` bps, playout delay, simulcast, Dynacast, and degradation preferences unchanged.
- Do not add server-side transcoding or automatic encoder adaptation.
- New UI copy must be available in English and Simplified Chinese.

---

### Task 1: Add shared current-meeting, admin-end, and codec contracts

**Files:**
- Modify: `packages/contracts/src/meeting.ts:5-105`
- Modify: `packages/contracts/src/meeting.test.ts:4-152`

**Interfaces:**
- Produces: `CurrentMeetingSchema`, `CurrentMeetingResponseSchema`, `AdminEndMeetingRequestSchema`, `ScreenShareCodecSchema`, and their `Static` types.
- Consumers: API routes in Tasks 2-3 and web codec state in Task 7.

- [ ] **Step 1: Write failing contract tests**

Add imports and assertions with these exact shapes:

```ts
expect(Value.Check(CurrentMeetingResponseSchema, {
  meeting: {
    slug: 'WnJ2wX1m4pL6qR8sT0vY3zA5bC7dE9fG',
    name: '周会',
    status: 'active',
    joinUrl: 'https://meet.example.test/meetings/WnJ2wX1m4pL6qR8sT0vY3zA5bC7dE9fG',
    requiresPassword: true,
    isFull: false
  }
})).toBe(true);
expect(Value.Check(CurrentMeetingResponseSchema, { meeting: null })).toBe(true);
expect(Value.Check(CurrentMeetingResponseSchema, {
  meeting: {
    slug: 'WnJ2wX1m4pL6qR8sT0vY3zA5bC7dE9fG', name: '周会', status: 'ended',
    joinUrl: 'https://meet.example.test/meetings/WnJ2wX1m4pL6qR8sT0vY3zA5bC7dE9fG',
    requiresPassword: true, isFull: false, passwordHash: 'secret'
  }
})).toBe(false);
expect(Value.Check(AdminEndMeetingRequestSchema, { adminPassword: 'secret' })).toBe(true);
expect(Value.Check(AdminEndMeetingRequestSchema, { adminPassword: '' })).toBe(false);
expect(['auto', 'h264', 'vp8'].every((codec) => Value.Check(ScreenShareCodecSchema, codec))).toBe(true);
expect(Value.Check(ScreenShareCodecSchema, 'vp9')).toBe(false);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run packages/contracts/src/meeting.test.ts`

Expected: FAIL because the new schemas are not exported.

- [ ] **Step 3: Implement the schemas and types**

Add after `MeetingSummary`:

```ts
export const NonTerminalMeetingStatusSchema = Type.Union([
  Type.Literal('created'),
  Type.Literal('active'),
  Type.Literal('grace')
]);

export const CurrentMeetingSchema = Type.Object({
  slug: Type.String({ minLength: 22, maxLength: 256 }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  status: NonTerminalMeetingStatusSchema,
  joinUrl: Type.String({ minLength: 1, pattern: '^https?://' }),
  requiresPassword: Type.Boolean(),
  isFull: Type.Boolean()
}, { additionalProperties: false });

export const CurrentMeetingResponseSchema = Type.Object({
  meeting: Type.Union([CurrentMeetingSchema, Type.Null()])
}, { additionalProperties: false });

export const AdminEndMeetingRequestSchema = Type.Object({
  adminPassword: Type.String({ minLength: 1, maxLength: 256 })
}, { additionalProperties: false });

export const ScreenShareCodecSchema = Type.Union([
  Type.Literal('auto'), Type.Literal('h264'), Type.Literal('vp8')
]);

export type CurrentMeeting = Static<typeof CurrentMeetingSchema>;
export type CurrentMeetingResponse = Static<typeof CurrentMeetingResponseSchema>;
export type AdminEndMeetingRequest = Static<typeof AdminEndMeetingRequestSchema>;
export type ScreenShareCodec = Static<typeof ScreenShareCodecSchema>;
```

- [ ] **Step 4: Run the contract suite and verify GREEN**

Run: `pnpm vitest run packages/contracts/src/meeting.test.ts`

Expected: all contract tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/meeting.ts packages/contracts/src/meeting.test.ts
git commit -m "Add current meeting and codec contracts"
```

### Task 2: Expose the synchronized current meeting publicly

**Files:**
- Modify: `apps/api/src/services/meeting-service.ts:45-123`
- Modify: `apps/api/src/http/routes/meetings.ts:1-42`
- Modify: `apps/api/test/meeting-service.test.ts:73-242`
- Modify: `apps/api/test/api.test.ts:26-78`

**Interfaces:**
- Consumes: `CurrentMeetingResponseSchema` from Task 1 and `MeetingRepository.findNonTerminal()`.
- Produces: `MeetingService.getCurrentMeetingSummary(): Promise<CurrentMeetingSummary | null>` and `GET /api/v1/meetings/current`.

- [ ] **Step 1: Write failing service tests**

```ts
it('returns only the synchronized current non-terminal meeting', async () => {
  const meeting = await service.createMeeting({ name: 'Daily', meetingPassword: 'join-secret' });

  await expect(service.getCurrentMeetingSummary()).resolves.toEqual({
    slug: meeting.slug,
    name: 'Daily',
    status: 'created',
    requiresPassword: true,
    isFull: false
  });

  await service.endMeeting(meeting.slug);
  await expect(service.getCurrentMeetingSummary()).resolves.toBeNull();
});

it('returns null when no non-terminal meeting exists', async () => {
  await expect(service.getCurrentMeetingSummary()).resolves.toBeNull();
});
```

- [ ] **Step 2: Run the service test and verify RED**

Run: `pnpm vitest run apps/api/test/meeting-service.test.ts -t "current non-terminal|no non-terminal"`

Expected: FAIL because `getCurrentMeetingSummary` does not exist.

- [ ] **Step 3: Implement the service method**

```ts
export interface CurrentMeetingSummary extends MeetingSummary {
  slug: string;
  status: 'created' | 'active' | 'grace';
}

async getCurrentMeetingSummary(): Promise<CurrentMeetingSummary | null> {
  const meeting = this.dependencies.repository.findNonTerminal();
  if (!meeting) return null;
  const summary = await this.getMeetingSummary(meeting.slug);
  if (summary.status === 'ended' || summary.status === 'expired') return null;
  return { slug: meeting.slug, ...summary };
}
```

- [ ] **Step 4: Add a failing HTTP test for public shape and empty state**

```ts
it('publishes only the current meeting join information', async () => {
  expect((await fixture.app.inject('/api/v1/meetings/current')).json()).toEqual({ meeting: null });
  const created = await fixture.createMeeting();
  const response = await fixture.app.inject('/api/v1/meetings/current');

  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({
    meeting: {
      slug: created.slug,
      name: 'Daily',
      status: 'created',
      joinUrl: `https://meet.example.test/meetings/${created.slug}`,
      requiresPassword: true,
      isFull: false
    }
  });
  expect(response.body).not.toContain('join-secret');
  expect(response.body).not.toContain('meeting-id');
});
```

- [ ] **Step 5: Register the static route before `/:slug`**

```ts
app.get('/api/v1/meetings/current', {
  schema: { response: { 200: CurrentMeetingResponseSchema } },
  preHandler: app.rateLimit(generalApiRateLimit())
}, async () => {
  const meeting = await dependencies.meetings.getCurrentMeetingSummary();
  return {
    meeting: meeting === null ? null : {
      ...meeting,
      joinUrl: new URL(`/meetings/${meeting.slug}`, dependencies.config.publicBaseUrl).toString()
    }
  };
});
```

- [ ] **Step 6: Run API and service suites**

Run: `pnpm vitest run apps/api/test/meeting-service.test.ts apps/api/test/api.test.ts`

Expected: both suites pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/meeting-service.ts apps/api/src/http/routes/meetings.ts apps/api/test/meeting-service.test.ts apps/api/test/api.test.ts
git commit -m "Expose the current meeting publicly"
```

### Task 3: End a meeting with the administrator password

**Files:**
- Modify: `apps/api/src/services/host-application-service.ts:35-86`
- Modify: `apps/api/src/http/routes/meetings.ts:1-78`
- Modify: `apps/api/test/application-services.test.ts:73-113`
- Modify: `apps/api/test/api.test.ts:140-216`

**Interfaces:**
- Consumes: `AdminEndMeetingRequestSchema`, `adminPasswordRateLimit()`, and `MeetingService.endMeeting(slug)`.
- Produces: `HostApplicationService.endMeetingWithAdminPassword(slug, adminPassword): Promise<void>` and `POST /api/v1/meetings/:slug/admin-end`.

- [ ] **Step 1: Write failing application-service tests**

```ts
it('ends and audits a meeting with the administrator password without creating host authority', async () => {
  const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
  await meetings.joinMeeting(meeting.slug, { nickname: 'Ada' });

  await hosts.endMeetingWithAdminPassword(meeting.slug, 'admin-secret');

  expect(repository.findBySlug(meeting.slug)?.status).toBe('ended');
  expect(db.prepare('SELECT event_type, meeting_id FROM audit_events WHERE event_type = ?')
    .get('meeting_ended_by_admin_password')).toEqual({
      event_type: 'meeting_ended_by_admin_password', meeting_id: meeting.id
    });
  expect(db.prepare('SELECT COUNT(*) AS count FROM host_sessions WHERE revoked_at IS NULL').get())
    .toEqual({ count: 0 });
});

it('does not end a meeting when the administrator password is wrong', async () => {
  const { meeting } = await hosts.createMeeting({ adminPassword: 'admin-secret', name: 'Daily' });
  await expect(hosts.endMeetingWithAdminPassword(meeting.slug, 'wrong'))
    .rejects.toMatchObject({ code: 'ADMIN_AUTH_FAILED' });
  expect(repository.findBySlug(meeting.slug)?.status).toBe('created');
});
```

- [ ] **Step 2: Run the service tests and verify RED**

Run: `pnpm vitest run apps/api/test/application-services.test.ts -t "administrator password"`

Expected: FAIL because the method does not exist.

- [ ] **Step 3: Implement one-time administrator termination**

```ts
async endMeetingWithAdminPassword(slug: string, adminPassword: string): Promise<void> {
  const valid = await this.dependencies.passwords.verify(
    this.dependencies.config.adminPasswordHash,
    adminPassword
  );
  if (!valid) throw domainError('ADMIN_AUTH_FAILED');

  const meeting = this.requireUsableMeeting(slug);
  await this.dependencies.meetings.endMeeting(slug);
  this.insertAudit('meeting_ended_by_admin_password', meeting.id, null);
}
```

This method must not call `createHostSession`, return a token, or set a cookie.

- [ ] **Step 4: Write failing HTTP tests for body validation, cookies, and rate limiting**

```ts
it('ends through the admin password endpoint without setting a host cookie', async () => {
  const created = await fixture.createMeeting();
  const response = await fixture.modify('POST', `${created.slug}/admin-end`, undefined, {
    adminPassword: 'admin-secret'
  });
  expect(response.statusCode, response.body).toBe(204);
  expect(response.headers['set-cookie']).toBeUndefined();
  expect((await fixture.app.inject('/api/v1/meetings/current')).json()).toEqual({ meeting: null });
});

it('shares the five-attempt administrator rate-limit bucket', async () => {
  const created = await fixture.createMeeting();
  for (let attempt = 0; attempt < 4; attempt++) {
    const failed = await fixture.modify('POST', `${created.slug}/admin-end`, undefined, {
      adminPassword: 'wrong'
    });
    expect(failed.statusCode).toBe(401);
  }
  const limited = await fixture.modify('POST', `${created.slug}/admin-end`, undefined, {
    adminPassword: 'wrong'
  });
  expect(limited.statusCode).toBe(429);
  expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
});
```

The loop is four because the successful creation consumed the first request in the shared five-request bucket. The next request is the sixth and must return 429.

- [ ] **Step 5: Register the endpoint**

```ts
app.post('/api/v1/meetings/:slug/admin-end', {
  schema: { params: SlugParamsSchema, body: AdminEndMeetingRequestSchema },
  preHandler: app.rateLimit(adminPasswordRateLimit())
}, async (request, reply) => {
  const body = request.body as { adminPassword: string };
  await dependencies.hosts.endMeetingWithAdminPassword(slug(request.params), body.adminPassword);
  return reply.status(204).send();
});
```

- [ ] **Step 6: Run the relevant backend suites**

Run: `pnpm vitest run apps/api/test/application-services.test.ts apps/api/test/api.test.ts`

Expected: all tests pass, invalid passwords return the uniform `ADMIN_AUTH_FAILED` envelope, and no response contains either password.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/host-application-service.ts apps/api/src/http/routes/meetings.ts apps/api/test/application-services.test.ts apps/api/test/api.test.ts
git commit -m "Allow password-gated meeting termination"
```

### Task 4: Show and manage the current meeting on the create page

**Files:**
- Modify: `apps/web/src/api/client.ts:12-42`
- Create: `apps/web/src/components/admin-end-meeting-form.tsx`
- Create: `apps/web/src/components/current-meeting-card.tsx`
- Modify: `apps/web/src/pages/create-meeting-page.tsx:1-53`
- Modify: `apps/web/src/pages/lobby.test.tsx:32-103`
- Modify: `apps/web/src/i18n/i18n.tsx:11-40,145-155`
- Modify: `apps/web/src/styles.css:16-39`

**Interfaces:**
- Consumes: `CurrentMeetingResponseSchema`, `CurrentMeeting`, and the administrator endpoint from Task 3.
- Produces: `apiNoContent(path, init)`, reusable `AdminEndMeetingForm`, `CurrentMeetingCard`, and visible-only 15-second current-meeting polling.

- [ ] **Step 1: Add a failing `apiNoContent` test**

```ts
it('parses the standard API error envelope for no-content actions', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({
    error: { code: 'ADMIN_AUTH_FAILED', message: 'Authentication failed', correlationId: 'corr-1' }
  }, 401)));

  await expect(apiNoContent('/meetings/current/admin-end', {
    method: 'POST', body: JSON.stringify({ adminPassword: 'wrong' })
  })).rejects.toMatchObject({ status: 401, details: { error: { code: 'ADMIN_AUTH_FAILED' } } });
});
```

- [ ] **Step 2: Implement the no-content client helper**

```ts
export async function apiNoContent(path: string, init: RequestInit = {}): Promise<void> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: jsonHeaders(init.headers)
  });
  if (!response.ok) throw await parseApiError(response);
}
```

- [ ] **Step 3: Write failing current-card tests**

Use a URL-aware fetch mock so the create page's initial GET does not invalidate existing creation assertions:

```ts
it('shows the public current meeting and ends it with an in-memory admin password', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/meetings/current') && !init?.method) return success({
      meeting: {
        slug, name: 'Design review', status: 'active',
        joinUrl: `https://meet.example/meetings/${slug}`,
        requiresPassword: true, isFull: false
      }
    });
    if (url.endsWith(`/meetings/${slug}/admin-end`)) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  renderAt('/create');

  expect(await screen.findByRole('heading', { name: 'Current meeting' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Join current meeting' }))
    .toHaveAttribute('href', `https://meet.example/meetings/${slug}`);
  await userEvent.type(screen.getByLabelText('Admin password to end meeting'), 'admin-secret');
  await userEvent.click(screen.getByRole('button', { name: 'End current meeting' }));
  expect(fetchMock).toHaveBeenCalledWith(`/api/v1/meetings/${slug}/admin-end`, expect.objectContaining({
    method: 'POST', body: JSON.stringify({ adminPassword: 'admin-secret' })
  }));
  expect(window.localStorage.getItem('adminPassword')).toBeNull();
  expect(window.sessionStorage.getItem('adminPassword')).toBeNull();
});
```

Also change the blank-name test to assert that no request with `method: 'POST'` was made; the initial public GET is expected.

- [ ] **Step 4: Implement `AdminEndMeetingForm`**

```tsx
export function AdminEndMeetingForm(props: {
  onEnd: (adminPassword: string) => Promise<void>;
  onEnded?: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [adminPassword, setAdminPassword] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    if (!adminPassword) return setError(t('adminEnd.passwordRequired'));
    setSubmitting(true);
    try {
      await props.onEnd(adminPassword);
      setAdminPassword('');
      props.onEnded?.();
    } catch (reason) {
      setError(reason instanceof ApiRequestError
        ? apiErrorText(reason, t, 'adminEnd.failed')
        : t('adminEnd.failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return <form className={props.compact ? 'admin-end-form compact' : 'admin-end-form'} onSubmit={submit}>
    <label>{t('adminEnd.password')}
      <input type="password" value={adminPassword} maxLength={256} autoComplete="current-password"
        aria-label={t('adminEnd.password')} onChange={(event) => setAdminPassword(event.target.value)} />
    </label>
    {error && <p className="message error" role="alert">{error}</p>}
    <button className="danger" disabled={submitting}>{submitting ? t('adminEnd.ending') : t('adminEnd.end')}</button>
  </form>;
}
```

- [ ] **Step 5: Implement the public card and polling lifecycle**

`CurrentMeetingCard` renders localized `created`, `active`, and `grace` labels, password/full badges, a real link when not full, an `aria-disabled` non-link when full, and `AdminEndMeetingForm`.

In `CreateMeetingPage`, add `currentMeeting`, `currentError`, this retryable loader, and its lifecycle effect:

```tsx
const currentRequestGeneration = useRef(0);
const loadCurrentMeeting = useCallback(async () => {
  const generation = ++currentRequestGeneration.current;
  try {
    const response = await apiRequest<CurrentMeetingResponse>(
      '/meetings/current', CurrentMeetingResponseSchema
    );
    if (generation !== currentRequestGeneration.current) return;
    setCurrentMeeting(response.meeting ?? undefined);
    setCurrentError(undefined);
  } catch {
    if (generation !== currentRequestGeneration.current) return;
    setCurrentError(t('current.lookupFailed'));
  }
}, [t]);

useEffect(() => {
  let timer: number | undefined;
  const reschedule = () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = document.hidden ? undefined : window.setInterval(() => void loadCurrentMeeting(), 15_000);
  };
  const visible = () => { if (!document.hidden) void loadCurrentMeeting(); reschedule(); };
  void loadCurrentMeeting();
  reschedule();
  document.addEventListener('visibilitychange', visible);
  return () => {
    currentRequestGeneration.current++;
    if (timer !== undefined) window.clearInterval(timer);
    document.removeEventListener('visibilitychange', visible);
  };
}, [loadCurrentMeeting]);
```

Render `currentError` with a retry button whose click is `() => void loadCurrentMeeting()`; meeting creation remains enabled while lookup is failing.

On creation, construct the immediate card before clearing inputs:

```ts
setCurrentMeeting({
  slug: response.slug,
  name: body.name,
  status: 'created',
  joinUrl: response.joinUrl,
  requiresPassword: Boolean(body.meetingPassword),
  isFull: false
});
```

The card end action clears the card, immediately calls `loadCurrentMeeting()` on success, and uses this exact request:

```ts
apiNoContent(`/meetings/${encodeURIComponent(slug)}/admin-end`, {
  method: 'POST',
  body: JSON.stringify({ adminPassword })
});
```

- [ ] **Step 6: Add English/Chinese copy and layout**

Add keys for current meeting heading, statuses, password/full badges, join/retry actions, and all `adminEnd.*` labels. Add `.current-meeting-card`, `.current-meeting-meta`, `.admin-end-form`, and `.create-sections` rules using the existing panel colors and mobile breakpoint; do not change the meeting-room stage sizing.

- [ ] **Step 7: Run focused web tests**

Run: `pnpm vitest run apps/web/src/pages/lobby.test.tsx apps/web/src/i18n/i18n.test.tsx`

Expected: current card, end flow, creation flow, retry behavior, language switching, and password non-persistence tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/components/admin-end-meeting-form.tsx apps/web/src/components/current-meeting-card.tsx apps/web/src/pages/create-meeting-page.tsx apps/web/src/pages/lobby.test.tsx apps/web/src/i18n/i18n.tsx apps/web/src/styles.css
git commit -m "Show and manage the current meeting"
```

### Task 5: Require a password in protected meeting lobbies

**Files:**
- Modify: `apps/web/src/pages/join-lobby-page.tsx:1-72`
- Modify: `apps/web/src/pages/lobby.test.tsx:105-253`
- Modify: `apps/web/src/i18n/i18n.tsx:30-43,153-157`

**Interfaces:**
- Consumes: existing `GET /meetings/:slug` and `MeetingSummarySchema`.
- Produces: client-side `requiresPassword` validation while leaving server verification authoritative.

- [ ] **Step 1: Write failing protected/unprotected lobby tests**

```ts
it('marks and validates the password for a protected meeting', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({
    name: 'Daily', status: 'created', requiresPassword: true, isFull: false
  })));
  renderAt(`/m/${slug}`);

  const password = await screen.findByLabelText('Meeting password');
  expect(password).toBeRequired();
  await userEvent.type(screen.getByLabelText('Nickname'), 'Ada');
  await userEvent.click(screen.getByRole('button', { name: 'Join muted' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Meeting password is required.');
});

it('keeps the password optional for an unprotected meeting', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({
    name: 'Daily', status: 'created', requiresPassword: false, isFull: false
  })));
  renderAt(`/m/${slug}`);
  expect(await screen.findByLabelText('Meeting password')).not.toBeRequired();
  expect(screen.getByText('optional')).toBeVisible();
});
```

- [ ] **Step 2: Run the two tests and verify RED**

Run: `pnpm vitest run apps/web/src/pages/lobby.test.tsx -t "protected meeting|unprotected meeting"`

Expected: FAIL because the lobby does not load summary data or set `required`.

- [ ] **Step 3: Load the summary and enforce only known protected meetings**

```tsx
const [summary, setSummary] = useState<MeetingSummary>();

useEffect(() => {
  let active = true;
  void apiRequest<MeetingSummary>(`/meetings/${encodeURIComponent(slug)}`, MeetingSummarySchema)
    .then((value) => { if (active) setSummary(value); })
    .catch((reason) => { if (active) setError(
      reason instanceof ApiRequestError ? apiErrorText(reason, t, 'join.failed') : t('join.failed')
    ); });
  return () => { active = false; };
}, [slug, t]);

const passwordRequired = summary?.requiresPassword === true;
```

Before joining, reject `passwordRequired && !meetingPassword`. Render `required={passwordRequired}`, `aria-required={passwordRequired}`, and show `join.required` instead of the optional marker when protected.

- [ ] **Step 4: Update join mocks to distinguish summary GET from join POST**

For tests that enter a room, return `MeetingSummary` for the first URL and `JoinMeetingResponse` for URLs ending in `/join`. Keep assertions that the password is omitted from the body for unprotected joins and never appears in storage or navigation.

- [ ] **Step 5: Run the complete lobby suite**

Run: `pnpm vitest run apps/web/src/pages/lobby.test.tsx apps/web/src/pages/join-room.integration.test.tsx`

Expected: all lobby and room-entry tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/join-lobby-page.tsx apps/web/src/pages/lobby.test.tsx apps/web/src/i18n/i18n.tsx
git commit -m "Require passwords in protected lobbies"
```

### Task 6: Let non-host participants end the meeting with the admin password

**Files:**
- Modify: `apps/web/src/pages/meeting-room-page.tsx:39-286`
- Modify: `apps/web/src/meeting/room.test.tsx:1-230`
- Modify: `apps/web/src/meeting/screen-share.test.tsx:1-853`
- Modify: `apps/web/src/styles.css:59-80`

**Interfaces:**
- Consumes: `AdminEndMeetingForm` from Task 4 and `POST /:slug/admin-end` from Task 3.
- Produces: `HostAuthorizationState = 'unknown' | 'authorized' | 'unauthorized'` and `MeetingRoomApi.adminEnd(slug, adminPassword)`.

- [ ] **Step 1: Write failing room authorization tests**

```tsx
it('shows admin-password termination only after host authorization is rejected', async () => {
  const adminEnd = vi.fn(async () => undefined);
  render(<MeetingRoomPage
    slug="meeting-slug" join={join} controller={meetingController()} listDevices={async () => []}
    meetingApi={{ ...unauthorizedMeetingApi(), adminEnd }}
  />);

  expect(screen.queryByLabelText('Admin password to end meeting')).not.toBeInTheDocument();
  const input = await screen.findByLabelText('Admin password to end meeting');
  await userEvent.type(input, 'admin-secret');
  await userEvent.click(screen.getByRole('button', { name: 'End current meeting' }));
  expect(adminEnd).toHaveBeenCalledWith('meeting-slug', 'admin-secret');
});

it('shows host controls without the participant admin-end form to an authenticated host', async () => {
  render(<MeetingRoomPage
    slug="meeting-slug" join={join} controller={meetingController()} listDevices={async () => []}
    meetingApi={{ ...unauthorizedMeetingApi(), authorizeHost: vi.fn(async () => undefined) }}
  />);
  expect(await screen.findByRole('heading', { name: 'Host controls' })).toBeVisible();
  expect(screen.queryByLabelText('Admin password to end meeting')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run apps/web/src/meeting/screen-share.test.tsx -t "admin-password termination|without the participant"`

Expected: FAIL because `MeetingRoomApi.adminEnd` and the non-host form do not exist.

- [ ] **Step 3: Add the API method and tri-state authorization**

```ts
export type HostAuthorizationState = 'unknown' | 'authorized' | 'unauthorized';

export interface MeetingRoomApi {
  // existing methods remain
  adminEnd(slug: string, adminPassword: string): Promise<void>;
}

adminEnd: (slug, adminPassword) => apiNoContent(
  `/meetings/${encodeURIComponent(slug)}/admin-end`,
  { method: 'POST', body: JSON.stringify({ adminPassword }) }
)
```

Initialize `hostAuthorization` to `unknown`. Change `authorizationChanged` to set both the existing boolean/ref and `authorized ? 'authorized' : 'unauthorized'`. Render the compact form only for `unauthorized`:

```tsx
{hostAuthorization === 'unauthorized' && <section className="participant-admin-end">
  <h2>{t('adminEnd.heading')}</h2>
  <AdminEndMeetingForm
    compact
    onEnd={(password) => meetingApi.adminEnd(slug, password)}
    onEnded={() => onTerminal?.('ended')}
  />
</section>}
```

- [ ] **Step 4: Update every `MeetingRoomApi` test fake**

Add `adminEnd: vi.fn().mockRejectedValue(new Error('not an admin'))` to `unauthorizedMeetingApi()` and `adminEnd: async () => undefined` to inline fakes. This is a mechanical type update; do not change host-control expectations.

- [ ] **Step 5: Style the compact side-rail form and run regressions**

Add a top border and one-rem padding matching `.host-menu`; keep its password input and destructive button full width below 40rem.

Run: `pnpm vitest run apps/web/src/meeting/room.test.tsx apps/web/src/meeting/screen-share.test.tsx apps/web/src/accessibility.test.tsx`

Expected: all selected suites pass and the form never flashes for a host.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/meeting-room-page.tsx apps/web/src/meeting/room.test.tsx apps/web/src/meeting/screen-share.test.tsx apps/web/src/styles.css
git commit -m "Add in-room admin meeting termination"
```

### Task 7: Publish screen shares with Auto, H.264, or VP8

**Files:**
- Modify: `apps/web/src/meeting/screen-share.ts:1-242`
- Modify: `apps/web/src/meeting/room-controller.ts:41-204`
- Modify: `apps/web/src/components/meeting-controls.tsx:1-63`
- Modify: `apps/web/src/pages/meeting-room-page.tsx:17-270`
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/meeting/room.test.tsx`
- Modify: `apps/web/src/i18n/i18n.tsx`

**Interfaces:**
- Consumes: `ScreenShareCodec` from Task 1.
- Produces: `ScreenShareController.start(profile, codec)`, codec-aware `publishScreenShare`, and a locked H.264-default selector.

- [ ] **Step 1: Write failing controller and publication tests**

```ts
it.each([
  ['h264', 'h264'],
  ['vp8', 'vp8'],
  ['auto', undefined]
] as const)('maps %s to the LiveKit video codec %s', async (requested, expected) => {
  const room = roomAdapter();
  room.localParticipant.publishTrack = vi.fn(async () => undefined);
  room.localParticipant.unpublishTrack = vi.fn(async () => undefined);
  const controller = createRoomController(() => room);
  await controller.connect(join);
  const { stream } = displayStream({ audio: false });

  await controller.publishScreenShare(stream, {
    maxBitrate: 10_000_000,
    frameRate: 60,
    degradationPreference: 'maintain-framerate',
    codec: requested
  });

  expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
    stream.getVideoTracks()[0],
    expect.objectContaining(expected ? { videoCodec: expected } : {})
  );
  if (expected === undefined) {
    expect(vi.mocked(room.localParticipant.publishTrack).mock.calls[0]?.[1])
      .not.toHaveProperty('videoCodec');
  }
});
```

Add a UI test asserting the selector starts at H.264, becomes disabled in `starting` and `sharing`, and forwards the selected value to `screenShare.start(screenProfile, screenCodec)`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run apps/web/src/meeting/room.test.tsx apps/web/src/meeting/screen-share.test.tsx -t "video codec|codec selector"`

Expected: FAIL because codec is absent from the controller APIs.

- [ ] **Step 3: Thread the codec through capture without changing constraints**

Change signatures to:

```ts
export interface ScreenSharePublisher {
  publish(stream: MediaStream, options: {
    maxBitrate: number;
    frameRate: number;
    degradationPreference: RTCDegradationPreference;
    codec: ScreenShareCodec;
  }): Promise<void>;
  release(stream: MediaStream): Promise<void>;
}

export interface ScreenShareController {
  start(profile: CaptureProfile, codec: ScreenShareCodec): Promise<void>;
  // remaining methods unchanged
}
```

Pass `codec` only in publication options. Do not alter `getDisplayMedia`, `contentHint`, audio capture, or either profile object.

- [ ] **Step 4: Map explicit codecs only at LiveKit publication**

Extend `MeetingRoomController.publishScreenShare` options with `codec: ScreenShareCodec`, then build video options as:

```ts
options: {
  source: Track.Source.ScreenShare,
  stream: 'screen-share',
  screenShareEncoding: { maxBitrate: options.maxBitrate, maxFramerate: options.frameRate },
  degradationPreference: options.degradationPreference,
  ...(options.codec === 'auto' ? {} : { videoCodec: options.codec })
}
```

Leave the screen-audio publication object unchanged so audio remains Opus under stream name `screen-share`.

- [ ] **Step 5: Add the selector**

Store `const [screenCodec, setScreenCodec] = useState<ScreenShareCodec>('h264')`. Extend `MeetingControlsProps` with `screenCodec` and `onScreenCodecChange`. Render adjacent to screen quality:

```tsx
<label>{t('controls.screenCodec')}<select
  aria-label={t('controls.screenCodec')}
  value={props.screenCodec ?? 'h264'}
  disabled={props.screenShareActive || props.screenShareBusy}
  onChange={(event) => props.onScreenCodecChange?.(event.target.value as ScreenShareCodec)}
>
  <option value="h264">{t('controls.codecH264')}</option>
  <option value="auto">{t('controls.codecAuto')}</option>
  <option value="vp8">{t('controls.codecVp8')}</option>
</select></label>
```

- [ ] **Step 6: Run screen-share and room suites**

Run: `pnpm vitest run apps/web/src/meeting/screen-share.test.tsx apps/web/src/meeting/room.test.tsx`

Expected: all tests pass; the motion profile remains exactly 1080p60, 10 Mbps, `motion`, and `maintain-framerate`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/meeting/screen-share.ts apps/web/src/meeting/room-controller.ts apps/web/src/components/meeting-controls.tsx apps/web/src/pages/meeting-room-page.tsx apps/web/src/meeting/screen-share.test.tsx apps/web/src/meeting/room.test.tsx apps/web/src/i18n/i18n.tsx
git commit -m "Add selectable screen share codecs"
```

### Task 8: Collect and display read-only WebRTC diagnostics

**Files:**
- Create: `apps/web/src/meeting/webrtc-stats.ts`
- Create: `apps/web/src/meeting/webrtc-stats.test.ts`
- Create: `apps/web/src/components/webrtc-stats-panel.tsx`
- Modify: `apps/web/src/meeting/room-controller.ts`
- Modify: `apps/web/src/meeting/room.test.tsx`
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Modify: `apps/web/src/i18n/i18n.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: normalized `ScreenShareDiagnosticsSnapshot`, pure delta calculations, `WebRtcStatsSampler`, optional `MeetingRoomState.screenShareDiagnostics`, and a collapsible panel.
- Consumes: LiveKit track `getRTCStatsReport()` only; React never receives the Room or peer connection.

- [ ] **Step 1: Write failing pure-statistics tests**

Define fixtures as plain records so tests do not depend on browser-created `RTCStatsReport` objects:

```ts
const previous = [
  { id: 'codec', type: 'codec', timestamp: 1_000, mimeType: 'video/H264' },
  { id: 'out', type: 'outbound-rtp', timestamp: 1_000, kind: 'video', codecId: 'codec',
    bytesSent: 1_000_000, framesEncoded: 100, framesSent: 100, totalEncodeTime: 2 }
];
const current = [
  { id: 'codec', type: 'codec', timestamp: 2_000, mimeType: 'video/H264' },
  { id: 'out', type: 'outbound-rtp', timestamp: 2_000, kind: 'video', codecId: 'codec',
    bytesSent: 2_250_000, framesEncoded: 160, framesSent: 160, framesDroppedByEncoder: 3,
    totalEncodeTime: 3.2, frameWidth: 1920, frameHeight: 1080, qualityLimitationReason: 'bandwidth' }
];

expect(deriveScreenShareDiagnostics(current, previous, {
  direction: 'sender', requestedCodec: 'h264', sampledAt: 2_000
})).toMatchObject({
  direction: 'sender', requestedCodec: 'h264',
  video: {
    mimeType: 'video/H264', width: 1920, height: 1080,
    bitrateBps: 10_000_000, framesPerSecond: 60,
    framesEncoded: 160, framesSent: 160, framesDroppedByEncoder: 3,
    averageEncodeTimeMs: 20, qualityLimitationReason: 'bandwidth'
  }
});
```

Add receiver fixtures asserting `bytesReceived` deltas, decoded FPS, `framesDropped`, `freezeCount`, `totalFreezesDuration`, jitter, and `jitterBufferDelay / jitterBufferEmittedCount`. Add an assertion that absent fields remain `undefined`, never zero.

- [ ] **Step 2: Run the new suite and verify RED**

Run: `pnpm vitest run apps/web/src/meeting/webrtc-stats.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement normalized types and pure derivation**

Create these public boundaries:

```ts
export type RtcStatRecord = { id: string; type: string; timestamp: number } & Record<string, unknown>;
export interface StatsTrack { getRTCStatsReport(): Promise<RTCStatsReport | undefined>; }
export interface ScreenShareStatsSource {
  direction: 'sender' | 'receiver';
  requestedCodec?: ScreenShareCodec;
  video: StatsTrack;
  audio?: StatsTrack;
}
export interface ScreenShareDiagnosticsSnapshot {
  sampledAt: number;
  direction: 'sender' | 'receiver';
  requestedCodec?: ScreenShareCodec;
  video: VideoDiagnostics;
  audio?: AudioDiagnostics;
  transport?: TransportDiagnostics;
}
export interface VideoDiagnostics {
  mimeType?: string;
  width?: number;
  height?: number;
  framesPerSecond?: number;
  bitrateBps?: number;
  framesEncoded?: number;
  framesSent?: number;
  framesDecoded?: number;
  framesDropped?: number;
  framesDroppedByEncoder?: number;
  averageEncodeTimeMs?: number;
  qualityLimitationReason?: string;
  qualityLimitationDurations?: Record<string, number>;
  nackCount?: number;
  pliCount?: number;
  firCount?: number;
  retransmittedBytesSent?: number;
  packetsLost?: number;
  freezeCount?: number;
  totalFreezesDurationMs?: number;
  jitterMs?: number;
  averageJitterBufferDelayMs?: number;
}
export interface AudioDiagnostics {
  jitterMs?: number;
  averageJitterBufferDelayMs?: number;
  packetsLost?: number;
}
export interface TransportDiagnostics {
  availableOutgoingBitrateBps?: number;
  roundTripTimeMs?: number;
}
export function statsRecords(report: RTCStatsReport | undefined): RtcStatRecord[];
export function deriveScreenShareDiagnostics(
  current: readonly RtcStatRecord[],
  previous: readonly RtcStatRecord[] | undefined,
  context: { direction: 'sender' | 'receiver'; requestedCodec?: ScreenShareCodec; sampledAt: number },
  audioCurrent?: readonly RtcStatRecord[],
  audioPrevious?: readonly RtcStatRecord[]
): ScreenShareDiagnosticsSnapshot;
```

Use matching stat IDs and positive timestamp deltas for bitrate/FPS. Resolve MIME type through `codecId`. Copy NACK, PLI, FIR, retransmission, freeze, packet-loss, quality-limitation reason, and quality-limitation duration values only when the browser supplies finite numbers. Read sender loss/RTT from `remote-inbound-rtp`, receiver loss from `inbound-rtp`, and available outgoing bitrate from the nominated succeeded `candidate-pair`. Convert seconds to the explicitly suffixed millisecond fields in the normalizer; the presentation component only rounds and adds units.

- [ ] **Step 4: Implement and test the one-second sampler lifecycle**

`WebRtcStatsSampler` accepts injectable `setInterval`, `clearInterval`, and `now`, exposes `setSource(source | undefined)`, `subscribe(listener)`, and `dispose()`. `setSource` clears the previous timer and prior sample, samples immediately, then every 1,000 ms. `undefined` or `dispose()` clears the timer and emits `undefined`. Catch per-sample failures and retain media operation.

Test with `vi.useFakeTimers()` that sampling starts, advances once per second, resets on source replacement, and stops after `dispose()`.

- [ ] **Step 5: Integrate stats sources into `RoomController`**

Extend adapters without exposing concrete LiveKit classes:

```ts
export interface LiveKitStatsTrackAdapter {
  getRTCStatsReport?(): Promise<RTCStatsReport | undefined>;
}
export interface LiveKitLocalTrackPublicationAdapter {
  track?: LiveKitStatsTrackAdapter;
}
```

Allow `publishTrack` to return `Promise<LiveKitLocalTrackPublicationAdapter | void>`, and add optional `getRTCStatsReport` to `LiveKitTrackAdapter`. Capture the video publication returned by local publish and set a sender source with the requested codec. Set a receiver source when a remote screen video subscribes, attach matching screen audio when it arrives, and clear the source on release, unsubscribe, disconnect, or replacement. Subscribe once to the sampler in the controller constructor and update `screenShareDiagnostics`; call `setSource(undefined)` in `releaseRoom` so the same controller and sampler can be reused during reconnect.

- [ ] **Step 6: Write controller lifecycle tests**

Use fake local and remote tracks whose `getRTCStatsReport` returns controlled reports. Assert sender direction after publication, receiver direction after subscription, the matching audio source after screen-audio subscription, and `screenShareDiagnostics: undefined` after unpublish/disconnect. Assert a rejected stats call does not reject `publishScreenShare` or disconnect playback.

- [ ] **Step 7: Implement the diagnostics panel**

Render `<WebRtcStatsPanel snapshot={state.screenShareDiagnostics} />` below `ScreenStage` only when `hasActiveScreenShare`. The component uses `<details className="webrtc-stats">`, a localized `<summary>`, a collecting message before the first sample, and compact sender/receiver definition lists. Format missing values as `—`; format bitrate as Mbps, time as ms, dimensions as `width × height`, and counters as integers. Do not compute or mutate encoder settings in the component.

- [ ] **Step 8: Add bilingual labels and non-intrusive layout**

Add labels for direction, requested/negotiated codec, resolution, FPS, bitrate, frames, dropped frames, encode time, limitation reason, NACK/PLI/FIR, retransmitted bytes, outgoing bandwidth, RTT, packet loss, freezes, jitter, jitter buffer, collecting, and unavailable. Keep `<details>` collapsed by default below 40rem and ensure the collapsed element does not change `.screen-stage` dimensions.

- [ ] **Step 9: Run diagnostics and room suites**

Run: `pnpm vitest run apps/web/src/meeting/webrtc-stats.test.ts apps/web/src/meeting/room.test.tsx apps/web/src/meeting/screen-share.test.tsx apps/web/src/i18n/i18n.test.tsx`

Expected: all tests pass; sampling errors remain isolated and no timer survives unmount/disconnect.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/meeting/webrtc-stats.ts apps/web/src/meeting/webrtc-stats.test.ts apps/web/src/components/webrtc-stats-panel.tsx apps/web/src/meeting/room-controller.ts apps/web/src/meeting/room.test.tsx apps/web/src/pages/meeting-room-page.tsx apps/web/src/i18n/i18n.tsx apps/web/src/styles.css
git commit -m "Add WebRTC screen share diagnostics"
```

### Task 9: Verify, publish, deploy, and inspect production

**Files:**
- Modify: `apps/web/e2e/create-join.spec.ts`
- Modify: `apps/web/e2e/host-controls.spec.ts`
- Verify: all source, test, production image, and release evidence files

**Interfaces:**
- Consumes: Tasks 1-8.
- Produces: a tested GitHub branch and a guarded full-stack production release.

- [ ] **Step 1: Add browser-level acceptance coverage**

Extend Playwright coverage to create a password-protected meeting, observe its public card in a second context, follow the link, require the meeting password, end once through a non-host admin form, and verify the card disappears. Extend the host flow to select H.264, confirm the selector locks during sharing, and open the statistics panel without requiring a particular negotiated codec in headless CI.

- [ ] **Step 2: Run complete automated verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`

Expected: every suite passes; typecheck, lint, API build, contracts build, and Vite production build exit 0. A Vite chunk-size warning is acceptable only if the build succeeds.

- [ ] **Step 3: Run browser acceptance locally**

Run: `pnpm --filter @meeting/web exec playwright test e2e/create-join.spec.ts e2e/host-controls.spec.ts`

Expected: public current meeting, protected join, both termination paths, codec selection, fullscreen, and diagnostics visibility pass.

- [ ] **Step 4: Check repository hygiene and push**

Run:

```bash
git diff --check
git status --short
git push origin codex/web-meeting-implementation
```

Expected: no whitespace errors, only intentional evidence artifacts remain untracked, and the remote branch head equals local `HEAD`.

- [ ] **Step 5: Perform the guarded target-host deployment**

In the already-open Aliyun terminal, fetch the pushed branch, check out the exact verified SHA, then run the repository's guarded command from `docs/runbooks/deployment-record.md` using the existing protected smoke token, network evidence, Cloudflare evidence, production env file, and confirmed origin IPv4. Do not print secret-file contents. The command must be:

```bash
bash scripts/deploy.sh --confirm-deploy "$(git rev-parse HEAD)" --target-ip "$ORIGIN_IPV4" \
  --smoke-token-file /protected/smoke-token \
  --network-evidence /protected/network.txt \
  --cloudflare-evidence /protected/cloudflare.txt
```

Expected: the script verifies the baseline release, takes a checksummed SQLite backup, builds API/web images, runs migrations, brings up the immutable release override, waits for all health checks, passes HTTPS/WSS smoke tests, and writes `var/releases/current-release.env`. If a preflight path differs on the existing server, resolve it with read-only `find`/`ls` checks before running; never create fake evidence.

- [ ] **Step 6: Inspect production behavior and WebRTC evidence**

Using Chrome or Edge on `https://meet.babagan.cloud`:

1. Verify `/create` shows no card when empty, then shows exactly one public card after creation.
2. Verify protected and unprotected lobbies mark the password correctly.
3. Verify correct admin password ends from `/create` and from a non-host room; wrong values and rate limits are localized.
4. Share once with H.264, Auto, and VP8, confirming the diagnostics panel reports the actual negotiated MIME type.
5. Run 1080p60 at 10 Mbps through rapid motion and record sender bitrate/FPS/quality limitation plus receiver freezes/jitter buffer; do not tune settings in this release.
6. Verify the fullscreen button, stage size, microphone, system-audio warning, and bilingual selector are unchanged.

- [ ] **Step 7: Record the deployed SHA and evidence paths**

Record the full Git SHA, release record path, backup/checksum path, image IDs, health output, smoke output, and browser acceptance result outside Git without credentials, passwords, participant names, or diagnostic media contents.
