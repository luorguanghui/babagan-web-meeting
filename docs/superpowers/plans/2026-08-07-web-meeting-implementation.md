# Web Meeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 2 核 2 GiB Debian 12 服务器上实现并部署一个单房间、最多 5 人、全员自由开麦、单人 1080p30/60 屏幕及电脑音频共享的网页会议系统。

**Architecture:** React 单页应用通过 `meet.babagan.cloud` 访问 Fastify API；API 使用 SQLite 保存临时会议、会话、预留和审计状态，并通过 LiveKit Server SDK 管理 SFU 房间、短期 Token 和发布权限。LiveKit 信令走 `rtc.babagan.cloud:443`，媒体优先走 UDP 50000–60000，TURN/UDP 443 和 RTC/TCP 7881 作为回退。Caddy 终止 HTTPS，Docker Compose 编排全部服务。

**Tech Stack:** Node.js 24 LTS、pnpm 10、TypeScript 5、React 19、Vite、Fastify 5、TypeBox、SQLite（better-sqlite3）、LiveKit Client/Server SDK、Vitest、Testing Library、Playwright、Docker Compose、Caddy。

## Global Constraints

- 已批准范围以 `docs/01-product-requirements.md` 至 `docs/06-security-and-privacy.md` 为准；不增加摄像头、录制、聊天、账号体系或 macOS 正式支持。
- 生产环境固定为一个 API 进程；会议级互斥锁因此可与 SQLite 事务共同保证 5 人容量和唯一共享者。若将来扩为多 API 实例，必须先把互斥改为数据库锁或外部协调服务。
- 所有时间在服务端使用 UTC Unix 毫秒；测试通过注入 `Clock` 控制时间，不在测试里真实等待。
- 所有随机身份通过注入 `IdGenerator` 生成；会议 `slug` 至少 128 位熵，会话 Token 为 256 位熵。
- 浏览器只保存 `HttpOnly; Secure; SameSite=Strict; Path=/` 的签名 Cookie；数据库只保存 SHA-256 Token 哈希，密码只保存 Argon2id 哈希。
- LiveKit JWT 固定 5 分钟；会议 24 小时到期；空房 10 分钟结束；断线身份保留 30 秒；加入预留 60 秒；最多 5 人。
- 每个应用任务遵循红—绿—重构：先写单个失败测试，运行并确认目标原因失败，再写最小实现，运行相关测试通过，最后提交。
- 不提交真实域名密钥、管理密码、Cookie Secret、Cloudflare 凭据或 LiveKit Secret。
- 每次任务结束运行其列出的检查命令；最终发布前运行完整门禁，不用单个测试结果代替整体验证。

---

## Repository Map

```text
.
├─ apps/
│  ├─ api/
│  │  ├─ src/
│  │  │  ├─ app.ts                 # Fastify 组装、插件和路由注册
│  │  │  ├─ server.ts              # 启动、信号处理和定时清理
│  │  │  ├─ config.ts              # 环境变量强校验
│  │  │  ├─ domain/                # 纯状态机、权限和错误
│  │  │  ├─ services/              # 会议、加入、主持、清理用例
│  │  │  ├─ repositories/          # SQLite 持久化边界
│  │  │  ├─ livekit/               # LiveKit Token、Server API、Webhook 适配器
│  │  │  ├─ http/                  # 路由、Cookie、Origin、错误映射
│  │  │  └─ db/                    # 连接、迁移和事务
│  │  └─ test/                     # 单元/集成测试与伪 LiveKit
│  └─ web/
│     ├─ src/
│     │  ├─ api/                    # 类型安全 HTTP 客户端
│     │  ├─ pages/                  # 创建、准备、会议页面
│     │  ├─ meeting/                # LiveKit 房间、音频、共享与重连逻辑
│     │  ├─ components/             # 可复用可访问组件
│     │  └─ test/                   # 浏览器 API 替身
│     └─ e2e/                       # Chrome/Edge 自动化核心流程
├─ packages/contracts/src/          # TypeBox schema、共享类型、错误码
├─ infra/
│  ├─ caddy/Caddyfile
│  ├─ livekit/livekit.yaml
│  ├─ web/Caddyfile
│  └─ docker-compose.yml
├─ scripts/                         # 部署、备份、恢复、冒烟和负载检查
└─ docs/                             # 已确认规格、运维记录和验收报告
```

## Public Interfaces to Preserve

```ts
// packages/contracts/src/index.ts
export type ApiErrorCode =
  | 'MEETING_NOT_FOUND'
  | 'MEETING_EXPIRED'
  | 'MEETING_FULL'
  | 'INVALID_MEETING_PASSWORD'
  | 'ADMIN_AUTH_FAILED'
  | 'SHARE_ALREADY_ACTIVE'
  | 'SHARE_NOT_AUTHORIZED'
  | 'UNSUPPORTED_CLIENT'
  | 'RATE_LIMITED'
  | 'MEDIA_SERVICE_UNAVAILABLE';

export interface Clock { now(): number }
export interface IdGenerator {
  uuid(): string;
  slug(): string;
  token(): string;
  participantIdentity(): string;
}
```

所有 HTTP JSON 路径使用 `/api/v1` 前缀。Cookie 名固定为 `wm_host` 和 `wm_participant`。错误响应固定为 `{ error: { code, message, correlationId } }`，不得暴露内部异常。

---

### Task 1: Initialize the Monorepo and Test Harness

**Files:**

- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `.npmrc`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `vitest.workspace.ts`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/index.test.ts`
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/src/index.test.tsx`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`

**Consumes:** Node.js 24.x and pnpm 10.x.  
**Produces:** `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build` commands usable from the repository root.

- [ ] Initialize version control and workspace metadata.

```powershell
git init
corepack enable
corepack prepare pnpm@10 --activate
pnpm init
```

Expected: Git reports an empty repository and `pnpm --version` starts with `10.`.

- [ ] Define root scripts and workspace packages.

```json
{
  "name": "babagan-web-meeting",
  "private": true,
  "packageManager": "pnpm@10",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm -r --parallel dev",
    "lint": "eslint .",
    "test": "vitest run --workspace vitest.workspace.ts",
    "test:watch": "vitest --workspace vitest.workspace.ts",
    "typecheck": "pnpm -r typecheck"
  }
}
```

Set package scripts exactly as follows: API uses `tsx watch src/server.ts`, `tsc -p tsconfig.json`, `node dist/server.js`, `vitest run`, and `tsc -p tsconfig.json --noEmit`; web uses `vite`, `tsc -b && vite build`, `vitest run`, and `tsc -b --noEmit`; contracts uses `tsc -p tsconfig.json`, `vitest run`, and `tsc -p tsconfig.json --noEmit`.

- [ ] Install the declared runtime and test toolchains; let the lock file preserve the resolved exact versions.

```powershell
pnpm add -Dw typescript@5 eslint@9 @eslint/js@9 typescript-eslint@8 vitest@4
pnpm --filter @meeting/contracts add @sinclair/typebox@0.34
pnpm --filter @meeting/api add fastify@5 @fastify/cookie@11 @fastify/cors@11 @fastify/helmet@13 @fastify/rate-limit@10 @fastify/type-provider-typebox@5 @sinclair/typebox@0.34 argon2@0.44 async-mutex@0.5 better-sqlite3@12 livekit-server-sdk@2 pino@10
pnpm --filter @meeting/api add -D @types/better-sqlite3@7 tsx@4
pnpm --filter @meeting/web add react@19 react-dom@19 react-router-dom@7 livekit-client@2
pnpm --filter @meeting/web add -D @playwright/test@1 @testing-library/dom@10 @testing-library/jest-dom@6 @testing-library/react@16 @testing-library/user-event@14 @types/react@19 @types/react-dom@19 @vitejs/plugin-react@5 jsdom@26 vite@7
```

Expected: pnpm reports no peer-dependency conflicts. If a major combination is incompatible at execution time, choose the newest mutually compatible release within the listed major lines, record the reason in the commit, and keep the resolved versions in `pnpm-lock.yaml`.

- [ ] Add one intentionally failing smoke test to each app and run it.

```ts
// apps/api/src/index.test.ts
import { describe, expect, it } from 'vitest';
describe('api workspace', () => {
  it('runs tests', () => expect('api').toBe('ready'));
});
```

First set the expected value to `'not-ready'` and run `pnpm test`; expected: two smoke suites are discovered and the API assertion fails. Change it to `'ready'`; expected: both suites pass.

- [ ] Install and lock dependencies, then run all baseline checks.

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

Expected: all commands exit `0`, and `pnpm-lock.yaml` exists.

- [ ] Commit the bootstrap.

```powershell
git add .gitignore .editorconfig .npmrc package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json eslint.config.mjs vitest.workspace.ts apps packages
git commit -m "chore: initialize meeting monorepo"
```

---

### Task 2: Define Shared HTTP Contracts and Configuration

**Files:**

- Create: `packages/contracts/src/errors.ts`
- Create: `packages/contracts/src/meeting.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/meeting.test.ts`
- Create: `apps/api/src/config.ts`
- Create: `apps/api/src/config.test.ts`
- Create: `.env.example`

**Consumes:** raw HTTP JSON and `process.env`.  
**Produces:** TypeBox schemas/types and `loadConfig(env): AppConfig`.

- [ ] Write failing schema tests for valid and invalid meeting inputs.

```ts
expect(Value.Check(CreateMeetingRequestSchema, {
  name: '周会', adminPassword: 'correct horse battery staple'
})).toBe(true);
expect(Value.Check(CreateMeetingRequestSchema, { name: '', adminPassword: '' })).toBe(false);
expect(Value.Check(JoinMeetingRequestSchema, { nickname: 'A'.repeat(41) })).toBe(false);
```

Run `pnpm --filter @meeting/contracts test`; expected: failure because schemas are not exported.

- [ ] Implement exact request/response schemas.

```ts
export const CreateMeetingRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  adminPassword: Type.String({ minLength: 1, maxLength: 256 }),
  meetingPassword: Type.Optional(Type.String({ minLength: 6, maxLength: 128 }))
}, { additionalProperties: false });

export const JoinMeetingRequestSchema = Type.Object({
  nickname: Type.String({ minLength: 1, maxLength: 40 }),
  meetingPassword: Type.Optional(Type.String({ maxLength: 128 }))
}, { additionalProperties: false });
```

Also define `MeetingSummarySchema`, `JoinMeetingResponseSchema`, `ParticipantSummarySchema`, `KickParticipantRequestSchema`, `ShareGrantRequestSchema`, and `ApiErrorResponseSchema`. Export static TypeScript types from the same schemas.

- [ ] Write failing configuration tests for missing/weak secrets, non-WSS LiveKit URL, and fixed limits.

```ts
expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/PUBLIC_BASE_URL/);
expect(() => loadConfig(validEnv({ COOKIE_SECRET: 'short' }))).toThrow(/32/);
expect(loadConfig(validEnv()).maxParticipants).toBe(5);
```

- [ ] Implement `loadConfig` with no production secret defaults.

```ts
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  publicBaseUrl: URL;
  livekitUrl: URL;
  livekitInternalUrl: URL;
  livekitApiKey: string;
  livekitApiSecret: string;
  adminPasswordHash: string;
  cookieSecret: string;
  databasePath: string;
  meetingTtlMs: 86_400_000;
  emptyGraceMs: 600_000;
  reconnectGraceMs: 30_000;
  reservationTtlMs: 60_000;
  maxParticipants: 5;
}
```

- [ ] Run contract checks and commit.

```powershell
pnpm --filter @meeting/contracts test
pnpm --filter @meeting/api test -- config.test.ts
pnpm typecheck
git add packages/contracts apps/api/src/config.ts apps/api/src/config.test.ts .env.example pnpm-lock.yaml
git commit -m "feat: define meeting contracts and configuration"
```

Expected: schema and configuration suites pass; `.env.example` contains names and safe development-only values, never production credentials.

---

### Task 3: Add SQLite Migrations and Repository Boundaries

**Files:**

- Create: `apps/api/src/db/migrations/001_initial.sql`
- Create: `apps/api/src/db/database.ts`
- Create: `apps/api/src/db/migrate.ts`
- Create: `apps/api/src/repositories/models.ts`
- Create: `apps/api/src/repositories/meeting-repository.ts`
- Create: `apps/api/src/repositories/sqlite-meeting-repository.ts`
- Create: `apps/api/test/repository.test.ts`

**Consumes:** validated repository records and UTC milliseconds.  
**Produces:** transaction-safe persistence for `meetings`, `host_sessions`, `participant_sessions`, `join_reservations`, `audit_events`, and `processed_webhooks`.

- [ ] Write failing migration tests against a temporary SQLite file.

```ts
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
  'meetings', 'host_sessions', 'participant_sessions',
  'join_reservations', 'audit_events', 'processed_webhooks'
]));
```

Run `pnpm --filter @meeting/api test -- repository.test.ts`; expected: migration module is missing.

- [ ] Implement the schema, including terminal-state and single-active-room constraints.

```sql
CREATE UNIQUE INDEX one_non_terminal_meeting
ON meetings ((1)) WHERE status IN ('created', 'active', 'grace');

CREATE INDEX reservation_expiry
ON join_reservations (meeting_id, expires_at);

CREATE UNIQUE INDEX one_processed_webhook
ON processed_webhooks (event_id);
```

Use foreign keys, `CHECK` constraints for state values, WAL mode, `busy_timeout = 5000`, and `synchronous = NORMAL`.

- [ ] Write failing repository tests for create conflict, optimistic share update, reservation expiry, session revocation, and webhook idempotency.

```ts
expect(repo.trySetShareIdentity(meeting.id, meeting.version, 'p1')).toEqual({ ok: true });
expect(repo.trySetShareIdentity(meeting.id, meeting.version, 'p2')).toEqual({ ok: false, reason: 'VERSION_CONFLICT' });
```

- [ ] Implement the repository interface and SQLite adapter.

```ts
export interface MeetingRepository {
  transaction<T>(fn: () => T): T;
  createMeeting(input: NewMeetingRecord): MeetingRecord;
  findBySlug(slug: string): MeetingRecord | null;
  findNonTerminal(): MeetingRecord | null;
  listLiveReservations(meetingId: string, now: number): JoinReservation[];
  insertReservation(value: JoinReservation): void;
  deleteReservation(identity: string): void;
  upsertParticipantSession(value: ParticipantSession): void;
  revokeParticipantSession(identity: string, at: number): void;
  trySetShareIdentity(meetingId: string, version: number, identity: string | null): ShareUpdateResult;
  markWebhookProcessed(eventId: string, at: number): boolean;
}
```

- [ ] Run tests, inspect the schema, and commit.

```powershell
pnpm --filter @meeting/api test -- repository.test.ts
pnpm --filter @meeting/api typecheck
git add apps/api/src/db apps/api/src/repositories apps/api/test/repository.test.ts pnpm-lock.yaml
git commit -m "feat: add sqlite meeting repository"
```

Expected: all persistence cases pass, and the second non-terminal meeting insertion fails atomically.

---

### Task 4: Implement Meeting Lifecycle and Capacity Rules

**Files:**

- Create: `apps/api/src/domain/errors.ts`
- Create: `apps/api/src/domain/time.ts`
- Create: `apps/api/src/services/keyed-mutex.ts`
- Create: `apps/api/src/services/meeting-service.ts`
- Create: `apps/api/test/fakes/fake-clock.ts`
- Create: `apps/api/test/fakes/fake-ids.ts`
- Create: `apps/api/test/meeting-service.test.ts`

**Consumes:** `MeetingRepository`, `MediaService`, `PasswordHasher`, `Clock`, and `IdGenerator`.  
**Produces:** `createMeeting`, `getMeetingSummary`, `joinMeeting`, `leaveMeeting`, `endMeeting`, and `runCleanup` use cases.

- [ ] Write failing time-boundary tests for 24-hour expiry, 10-minute empty grace, 30-second reconnect grace, and 60-second reservations.

```ts
clock.set(createdAt + 86_400_000);
await expect(service.joinMeeting(slug, request)).rejects.toMatchObject({ code: 'MEETING_EXPIRED' });
clock.set(emptySince + 599_999);
expect(await service.runCleanup()).not.toContain(slug);
clock.set(emptySince + 600_000);
expect(await service.runCleanup()).toContain(slug);
```

- [ ] Implement pure lifecycle decisions and use injected time only.

```ts
export function nextMeetingStatus(input: {
  status: MeetingStatus;
  participantCount: number;
  now: number;
  expiresAt: number;
  emptySince: number | null;
}): MeetingTransition;
```

- [ ] Write a failing concurrent join test using six simultaneous requests.

```ts
const results = await Promise.allSettled(
  Array.from({ length: 6 }, (_, i) => service.joinMeeting(slug, { nickname: `P${i + 1}` }))
);
expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(5);
expect(results.filter(x => x.status === 'rejected')).toHaveLength(1);
```

- [ ] Implement meeting-keyed serialization and union-based occupancy.

```ts
return mutex.runExclusive(meeting.id, async () => {
  const connected = await media.listParticipantIdentities(meeting.id);
  const reserved = repo.listLiveReservations(meeting.id, clock.now());
  const occupied = new Set([...connected, ...reserved.map(x => x.identity)]);
  if (occupied.size >= config.maxParticipants) throw domainError('MEETING_FULL');
  return issueReservationAndSession(meeting, input);
});
```

- [ ] Add create-conflict, leave, process-restart cleanup, and terminal-session-revocation tests; implement the minimal service behavior.

- [ ] Run domain tests and commit.

```powershell
pnpm --filter @meeting/api test -- meeting-service.test.ts
pnpm --filter @meeting/api typecheck
git add apps/api/src/domain apps/api/src/services apps/api/test/fakes apps/api/test/meeting-service.test.ts
git commit -m "feat: enforce meeting lifecycle and capacity"
```

Expected: exactly five of six joins succeed, no real timers are used, and all boundary tests pass at the exact millisecond.

---

### Task 5: Add Passwords, Signed Sessions, Origin Checks, and Rate Limits

**Files:**

- Create: `apps/api/src/security/password-hasher.ts`
- Create: `apps/api/src/security/session-token.ts`
- Create: `apps/api/src/http/auth.ts`
- Create: `apps/api/src/http/origin.ts`
- Create: `apps/api/src/http/rate-limit.ts`
- Create: `apps/api/test/security.test.ts`

**Consumes:** management/meeting passwords, signed cookies, request origin and client IP.  
**Produces:** constant-behavior authentication, hashed session records, host/participant guards, and endpoint-specific rate-limit keys.

- [ ] Write failing tests proving Argon2id verification, SHA-256 session storage, cookie tamper rejection, and identical public password errors.

```ts
const raw = ids.token();
expect(hashSessionToken(raw)).toMatch(/^[a-f0-9]{64}$/);
expect(hashSessionToken(raw)).not.toContain(raw);
await expect(authenticateMeeting('wrong')).rejects.toMatchObject({ code: 'INVALID_MEETING_PASSWORD' });
```

- [ ] Implement `PasswordHasher` and session primitives.

```ts
export interface PasswordHasher {
  hash(value: string): Promise<string>;
  verify(hash: string, value: string): Promise<boolean>;
}
export const hostCookie = 'wm_host';
export const participantCookie = 'wm_participant';
```

Use Argon2id settings that fit the 2 GiB host under five concurrent attempts; document the measured memory cost in the security test output.

- [ ] Write failing request-level tests for missing/wrong `Origin`, host cookie scope, participant cookie scope, and excessive failures.

- [ ] Register strict Origin validation for every modifying route and rate limits separately for admin-password attempts, meeting-password attempts, and general API traffic. Map limit failures to `RATE_LIMITED` without revealing whether a meeting or session exists.

- [ ] Verify cookies contain `HttpOnly`, `Secure`, `SameSite=Strict`, and exact path; then commit.

```powershell
pnpm --filter @meeting/api test -- security.test.ts
pnpm --filter @meeting/api typecheck
git add apps/api/src/security apps/api/src/http apps/api/test/security.test.ts pnpm-lock.yaml
git commit -m "feat: secure passwords and browser sessions"
```

---

### Task 6: Implement the LiveKit Adapter, Tokens, and Webhook Idempotency

**Files:**

- Create: `apps/api/src/livekit/media-service.ts`
- Create: `apps/api/src/livekit/livekit-media-service.ts`
- Create: `apps/api/src/livekit/token-service.ts`
- Create: `apps/api/src/livekit/webhook-handler.ts`
- Create: `apps/api/test/fakes/fake-media-service.ts`
- Create: `apps/api/test/livekit.test.ts`

**Consumes:** meeting/participant identity, requested permission set, signed LiveKit webhook bytes.  
**Produces:** 5-minute JWTs, room administration, permission updates, participant lists, readiness checks, and idempotent domain events.

- [ ] Write failing token tests for room binding, five-minute expiry, microphone-only default grants, and screen grants.

```ts
expect(decoded.video.room).toBe(meetingId);
expect(decoded.video.canSubscribe).toBe(true);
expect(decoded.video.canPublishSources).toEqual(['microphone']);
expect(decoded.exp - decoded.iat).toBe(300);
```

- [ ] Implement `MediaService` and LiveKit SDK adapter.

```ts
export interface MediaService {
  listParticipantIdentities(roomName: string): Promise<Set<string>>;
  issueToken(input: IssueTokenInput): Promise<string>;
  updateParticipantSources(roomName: string, identity: string, sources: PublishSource[]): Promise<void>;
  removeParticipant(roomName: string, identity: string): Promise<void>;
  deleteRoom(roomName: string): Promise<void>;
  ping(): Promise<void>;
}
```

Normal sources are exactly `['microphone']`; the authorized sharer receives `['microphone', 'screen_share', 'screen_share_audio']`. Camera and data publishing stay disabled.

- [ ] Write failing webhook tests for bad signatures, duplicate event IDs, participant join reservation cleanup, revoked participant rejoin removal, participant leave/grace entry, track-unpublished share release, and room-finished terminal cleanup.

- [ ] Implement signature verification with the LiveKit receiver using raw request bytes. Insert `processed_webhooks.event_id` in the same database transaction as each state mutation; a duplicate returns `204` without repeating effects.

- [ ] Run the adapter tests and commit.

```powershell
pnpm --filter @meeting/api test -- livekit.test.ts
pnpm --filter @meeting/api typecheck
git add apps/api/src/livekit apps/api/test/fakes/fake-media-service.ts apps/api/test/livekit.test.ts pnpm-lock.yaml
git commit -m "feat: integrate livekit media control"
```

---

### Task 7: Expose the Fastify API and Health Endpoints

**Files:**

- Create: `apps/api/src/http/error-handler.ts`
- Create: `apps/api/src/http/routes/meetings.ts`
- Create: `apps/api/src/http/routes/participants.ts`
- Create: `apps/api/src/http/routes/livekit-webhook.ts`
- Create: `apps/api/src/http/routes/health.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/test/api.test.ts`

**Consumes:** TypeBox contracts and application services.  
**Produces:** every approved `/api/v1` endpoint, `/internal/livekit/webhook`, `/health/live`, and `/health/ready`.

- [ ] Write a failing integration test for `POST /api/v1/meetings` that asserts status `201`, unpredictable slug, host cookie, and no password echo.

- [ ] Implement app construction as an injectable factory.

```ts
export interface AppDependencies {
  config: AppConfig;
  meetings: MeetingService;
  hosts: HostService;
  media: MediaService;
  webhooks: WebhookHandler;
}
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance>;
```

- [ ] Add failing tests, then implement each route in this fixed order:

```text
POST   /api/v1/meetings
GET    /api/v1/meetings/:slug
POST   /api/v1/meetings/:slug/join
POST   /api/v1/meetings/:slug/token
POST   /api/v1/meetings/:slug/leave
GET    /api/v1/meetings/:slug/participants
POST   /api/v1/meetings/:slug/end
POST   /api/v1/meetings/:slug/kick
PUT    /api/v1/meetings/:slug/share-grant
DELETE /api/v1/meetings/:slug/share-grant
POST   /internal/livekit/webhook
GET    /health/live
GET    /health/ready
```

For join, assert response fields are exactly `participantIdentity`, `participantName`, `livekitUrl`, `token`, `meetingExpiresAt`, and `permissions`; set `wm_participant` in the same response.

- [ ] Test the complete error table. Unknown/internal errors return status `500` and a generated `correlationId`; logs contain the correlation ID but response JSON contains no stack, SQL, secret or internal URL.

- [ ] Add startup migration, immediate recovery cleanup, 30-second non-overlapping cleanup interval, `SIGTERM` shutdown, and database close behavior to `server.ts`.

- [ ] Run API integration checks and commit.

```powershell
pnpm --filter @meeting/api test -- api.test.ts
pnpm --filter @meeting/api typecheck
pnpm --filter @meeting/api build
git add apps/api/src/http apps/api/src/app.ts apps/api/src/server.ts apps/api/test/api.test.ts
git commit -m "feat: expose meeting http api"
```

Expected: all routes validate bodies and origins, unauthorized host/participant calls fail, health semantics differ correctly, and the process closes cleanly.

---

### Task 8: Build the Web Shell, Creation Page, and Join Lobby

**Files:**

- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app.tsx`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/pages/create-meeting-page.tsx`
- Create: `apps/web/src/pages/join-lobby-page.tsx`
- Create: `apps/web/src/components/device-check.tsx`
- Create: `apps/web/src/test/browser-fakes.ts`
- Create: `apps/web/src/pages/lobby.test.tsx`

**Consumes:** shared contract types, HTTPS browser APIs, typed API responses.  
**Produces:** `/create` and `/m/:slug` routes, meeting creation link UI, compatibility/device checks, microphone meter and muted join.

- [ ] Write failing UI tests for creation form validation, successful link display/copy, API error display, and non-persistence of the admin password.

- [ ] Implement the typed API client and creation page. The client must always send `credentials: 'include'`, `Content-Type: application/json`, and parse only the shared success/error contracts.

```ts
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { ...init, credentials: 'include' });
  if (!response.ok) throw await parseApiError(response);
  return response.json() as Promise<T>;
}
```

- [ ] Write failing lobby tests for unsupported OS/browser, non-HTTPS, missing WebRTC, explicit device-check click, nickname/password validation, muted default, and denied microphone permission.

- [ ] Implement capability checks for Windows 10/11 latest Chrome/Edge as the supported desktop path. Mobile may continue in view/voice-only mode with a visible limitation notice; macOS shows unsupported guidance and is not included in acceptance.

- [ ] Implement microphone level metering with `AudioContext` and immediately stop all preview tracks on unmount or after join. Add a user-triggered speaker test sound; do not auto-play it.

- [ ] Run UI tests and commit.

```powershell
pnpm --filter @meeting/web test -- lobby.test.tsx
pnpm --filter @meeting/web typecheck
pnpm --filter @meeting/web build
git add apps/web packages/contracts pnpm-lock.yaml
git commit -m "feat: add creation and join lobby"
```

---

### Task 9: Implement Room Connection and Free Microphone Control

**Files:**

- Create: `apps/web/src/meeting/room-controller.ts`
- Create: `apps/web/src/meeting/use-meeting-room.ts`
- Create: `apps/web/src/meeting/audio-playback.ts`
- Create: `apps/web/src/components/participant-list.tsx`
- Create: `apps/web/src/components/meeting-controls.tsx`
- Create: `apps/web/src/pages/meeting-room-page.tsx`
- Create: `apps/web/src/meeting/room.test.tsx`

**Consumes:** join response, LiveKit client events, device choice and participant actions.  
**Produces:** room connection, participant roster, all-user mic toggle, device switching, remote audio playback recovery, connection status and leave behavior.

- [ ] Write a failing room-controller test asserting `autoSubscribe`, adaptive stream, dynacast, muted join, and microphone constraints.

```ts
expect(room.connect).toHaveBeenCalledWith(livekitUrl, token, expect.objectContaining({ autoSubscribe: true }));
expect(local.setMicrophoneEnabled).not.toHaveBeenCalled();
expect(audioConstraints).toMatchObject({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
});
```

- [ ] Implement `RoomController` behind an interface so tests do not need a real SFU.

```ts
export interface MeetingRoomController {
  connect(join: JoinMeetingResponse): Promise<void>;
  setMicrophoneEnabled(enabled: boolean, deviceId?: string): Promise<void>;
  switchAudioOutput(deviceId: string): Promise<'changed' | 'unsupported'>;
  disconnect(): Promise<void>;
  subscribe(listener: (state: MeetingRoomState) => void): () => void;
}
```

- [ ] Write failing UI tests for five visible participants, independent mic states, any member freely unmuting, device switching, graceful leave API call, and remote audio blocked by autoplay.

- [ ] Implement participant list and a compact control bar containing only microphone, devices, screen share, leave/end, and connection state. Add “点击恢复声音” only when `HTMLMediaElement.play()` is rejected.

- [ ] Run room tests and commit.

```powershell
pnpm --filter @meeting/web test -- room.test.tsx
pnpm --filter @meeting/web typecheck
git add apps/web/src/meeting apps/web/src/components apps/web/src/pages/meeting-room-page.tsx
git commit -m "feat: connect room audio and participant controls"
```

---

### Task 10: Add Unique Screen Sharing and Host Controls

**Files:**

- Create: `apps/api/src/services/host-service.ts`
- Create: `apps/api/test/host-service.test.ts`
- Create: `apps/web/src/meeting/screen-share.ts`
- Create: `apps/web/src/components/screen-stage.tsx`
- Create: `apps/web/src/components/host-menu.tsx`
- Create: `apps/web/src/meeting/screen-share.test.tsx`

**Consumes:** host session, target identity, LiveKit permission updates, browser display-media result.  
**Produces:** atomic share grant/revoke, host kick/end, 1080p30/60 capture, computer-audio status and aspect-preserving rendering.

- [ ] Write failing service tests for two concurrent grants, unauthorized host, target absence, permission-update failure, revoke, sharer disconnect, kick, and end.

```ts
const [a, b] = await Promise.allSettled([
  hosts.grantShare(hostSession, 'p1'),
  hosts.grantShare(hostSession, 'p2')
]);
expect([a, b].filter(x => x.status === 'fulfilled')).toHaveLength(1);
expect(repo.getMeeting(meetingId).shareIdentity).toMatch(/^p[12]$/);
```

- [ ] Implement grant as: validate host and target → optimistic database lock → update LiveKit sources → audit. If LiveKit update fails, transactionally clear the matching lock and emit a system-error audit event. Revoke must remove LiveKit sources before clearing the database lock, leaving the stricter state on partial failure.

- [ ] Write failing browser tests for unauthorized button state, standard/high-motion constraints, missing system-audio track guidance, browser-ended track cleanup, and `object-fit: contain`.

- [ ] Implement exact capture profiles.

```ts
export const captureProfiles = {
  standard: { width: 1920, height: 1080, frameRate: 30, maxBitrate: 8_000_000 },
  motion: { width: 1920, height: 1080, frameRate: 60, maxBitrate: 15_000_000 }
} as const;
```

Call screen capture only after the server grant succeeds. Request audio, inspect the returned audio tracks, and show platform/source instructions when none is returned. Track `ended` must call revoke/release and update the UI even if the HTTP request fails.

- [ ] Implement host-only participant menu for grant/revoke and kick, plus host end-meeting confirmation. Never render management controls based only on URL state; require a successful host-authorized API response.

- [ ] Run API and web sharing tests, then commit.

```powershell
pnpm --filter @meeting/api test -- host-service.test.ts
pnpm --filter @meeting/web test -- screen-share.test.tsx
pnpm typecheck
git add apps/api/src/services/host-service.ts apps/api/test/host-service.test.ts apps/web/src/meeting/screen-share.ts apps/web/src/components apps/web/src/meeting/screen-share.test.tsx
git commit -m "feat: add controlled screen sharing and host actions"
```

---

### Task 11: Implement Token Refresh, Reconnect, Error UX, and Accessibility

**Files:**

- Create: `apps/api/test/reconnect.test.ts`
- Create: `apps/web/src/meeting/reconnect-controller.ts`
- Create: `apps/web/src/components/connection-banner.tsx`
- Create: `apps/web/src/components/error-boundary.tsx`
- Create: `apps/web/src/meeting/reconnect.test.tsx`
- Create: `apps/web/src/accessibility.test.tsx`

**Consumes:** LiveKit reconnect events, participant cookie, API error contract, network online/offline events.  
**Produces:** fresh 5-minute tokens for valid sessions, kicked-user rejection, 30-second identity grace UX, terminal routing, correlation-ID error display and keyboard/screen-reader support.

- [ ] Write failing API tests for valid refresh, expired meeting, revoked session, mismatched meeting/session, and webhook removal of a revoked identity that reconnects with an old JWT.

- [ ] Implement refresh without accepting identity from the request body; derive meeting and identity only from `wm_participant`. Every refreshed token preserves microphone-only or current authorized-share sources from server state.

- [ ] Write failing UI tests for 10-second recovery, over-30-second recovery requiring rejoin, expired/ended redirect, offline banner, and rate-limit retry text.

- [ ] Implement a single reconnect state machine.

```ts
export type ReconnectState =
  | { kind: 'connected' }
  | { kind: 'reconnecting'; since: number }
  | { kind: 'refreshing-token'; since: number }
  | { kind: 'rejoin-required'; reason: 'grace-expired' | 'session-revoked' }
  | { kind: 'terminal'; reason: 'ended' | 'expired' };
```

Only one token refresh may be in flight. Apply capped exponential retry within the 30-second window and stop retrying on terminal/authorization errors.

- [ ] Add visible focus, semantic labels, keyboard access for all controls, polite live regions for connection/mic/share changes, and a non-color-only connection indicator. Run automated accessibility assertions.

- [ ] Run reconnect/accessibility suites and commit.

```powershell
pnpm --filter @meeting/api test -- reconnect.test.ts
pnpm --filter @meeting/web test -- reconnect.test.tsx accessibility.test.tsx
pnpm typecheck
git add apps/api/test/reconnect.test.ts apps/web/src/meeting/reconnect-controller.ts apps/web/src/components apps/web/src/meeting/reconnect.test.tsx apps/web/src/accessibility.test.tsx
git commit -m "feat: handle reconnect and accessible errors"
```

---

### Task 12: Package the Production Containers and Network Configuration

**Files:**

- Create: `apps/api/Dockerfile`
- Create: `apps/web/Dockerfile`
- Create: `infra/web/Caddyfile`
- Create: `infra/caddy/Caddyfile`
- Create: `infra/livekit/livekit.yaml`
- Create: `infra/docker-compose.yml`
- Create: `infra/.env.production.example`
- Create: `infra/compose-config.test.mjs`

**Consumes:** built API/web artifacts, production secrets supplied at deployment, three configured DNS records.  
**Produces:** reproducible non-root containers, private backend network, persistent SQLite/Caddy data, HTTPS/WSS, direct media ports and health checks.

- [ ] Write a failing static infrastructure test that parses rendered Compose config and asserts only approved public ports.

```js
assert.deepEqual(publicPorts.sort(), [
  '80/tcp', '443/tcp', '443/udp', '7881/tcp', '50000-60000/udp'
]);
assert.equal(apiPorts.length, 0);
assert.equal(livekitSignalPorts.length, 0);
```

Run `node infra/compose-config.test.mjs`; expected: failure because Compose files do not exist.

- [ ] Build multi-stage images. API runtime runs as a numeric non-root user with a read-only root filesystem and writable `/data`; web image serves only immutable assets and SPA fallback.

- [ ] Configure Caddy with HTTP/1.1 and HTTP/2 only so UDP 443 remains available to TURN.

```caddyfile
{
  servers {
    protocols h1 h2
  }
}

meet.babagan.cloud {
  handle /api/* { reverse_proxy api:3000 }
  handle /health/* { reverse_proxy api:3000 }
  handle { reverse_proxy web:8080 }
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
    Permissions-Policy "camera=(), microphone=(self), display-capture=(self)"
  }
}

rtc.babagan.cloud {
  reverse_proxy livekit:7880
}
```

- [ ] Configure LiveKit with `use_external_ip: true`, RTC/TCP 7881, UDP 50000–60000, embedded TURN/UDP 443 at `turn.babagan.cloud`, and keys only from runtime environment/secrets. Do not publish internal 7880.

- [ ] Add Compose health checks and dependency conditions. Set memory reservations/limits only after local measurement; hard limits must leave enough headroom for Docker and the OS on the 2 GiB host. Use log rotation (`10m`, 3 files).

- [ ] Render, inspect, build, and commit.

```powershell
docker compose --env-file infra/.env.production.example -f infra/docker-compose.yml config
node infra/compose-config.test.mjs
docker compose --env-file infra/.env.production.example -f infra/docker-compose.yml build
git add apps/api/Dockerfile apps/web/Dockerfile infra
git commit -m "ops: package production meeting stack"
```

Expected: no secret is embedded in an image or rendered example; API, SQLite and LiveKit 7880 are not publicly bound.

---

### Task 13: Add E2E, Smoke, Backup, and Load-Test Tooling

**Files:**

- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/create-join.spec.ts`
- Create: `apps/web/e2e/host-controls.spec.ts`
- Create: `scripts/smoke-test.sh`
- Create: `scripts/backup.sh`
- Create: `scripts/restore.sh`
- Create: `scripts/load-test.mjs`
- Create: `scripts/collect-webrtc-stats.mjs`
- Create: `docs/templates/acceptance-report.md`

**Consumes:** running Compose stack, test admin hash/password, temporary SQLite database, synthetic LiveKit participants and browser statistics.  
**Produces:** repeatable Chromium/Edge core checks, safe SQLite backup/restore, five-person load evidence and a standard acceptance report.

- [ ] Write Playwright tests for create → five joins → sixth rejected, default muted/free unmute, host grant/kick/end, and terminal redirect. Use a fake media adapter for deterministic CI; configure projects named `chrome` and `edge` with installed browser channels.

- [ ] Run the E2E test first against no server; expected: a clear connection failure. Start the test stack and rerun.

```powershell
pnpm --filter @meeting/web exec playwright install chromium msedge
pnpm --filter @meeting/web exec playwright test
```

Expected: both browser projects pass the non-permission-dialog core path.

- [ ] Implement `smoke-test.sh` to check DNS resolution, TLS, `/health/live`, `/health/ready`, SPA loading, WebSocket upgrade, and absence of public 3000/7880 ports. Exit nonzero on the first failed invariant.

- [ ] Implement online SQLite backup using `.backup`, checksum generation, restrictive permissions and retention. Implement restore to a new file, run `PRAGMA integrity_check`, then require an explicit file swap outside the script. The restore script must never overwrite the live database automatically.

- [ ] Implement load tooling for one room, five microphone publishers, one 1080p60 screen/video publisher and four subscribers. Record CPU, RSS, container restarts, outbound bandwidth, packet loss and 5xx counts every 10 seconds for two hours.

- [ ] Add the acceptance template fields: build SHA, browser versions, server specs, network paths, WebRTC stats, 30-minute memory averages, failure evidence, rollback result and approver.

- [ ] Run deterministic tooling tests and commit.

```powershell
pnpm test
pnpm typecheck
pnpm lint
git add apps/web/e2e apps/web/playwright.config.ts scripts docs/templates
git commit -m "test: add end-to-end and operations tooling"
```

---

### Task 14: Harden, Deploy, and Complete Acceptance

**Files:**

- Create: `scripts/deploy.sh`
- Create: `scripts/rollback.sh`
- Create: `docs/runbooks/deployment-record.md`
- Create: `docs/runbooks/rollback-record.md`
- Create: `docs/acceptance/initial-release.md`
- Modify: `README.md`

**Consumes:** tested commit SHA, target Debian server, Cloudflare DNS already configured, generated production secrets.  
**Produces:** reproducible deployment, verified firewall/TLS/media paths, recoverable rollback and signed initial-release evidence.

- [ ] Implement deployment preflight: require Debian 12, Docker/Compose, at least 1.5 GiB available RAM, at least 10 GiB free disk, DNS resolving to the target IP, ports free, env file mode `600`, and a successful backup. Abort before mutation if any check fails.

- [ ] Implement deployment as pull/build → migration in a one-shot API command → `docker compose up -d` → bounded health wait → smoke test. Record deployed image digests and Git SHA. Do not delete the previous images or backup.

- [ ] Implement rollback using the recorded previous image digests and the pre-deploy database backup. Require an explicit confirmation argument containing the target release SHA; verify health and smoke tests after rollback.

- [ ] On Alibaba Cloud and the host firewall, verify the only public inbound ports are TCP 80/443/7881 and UDP 443/50000–60000. Confirm Cloudflare remains orange for `meet` and DNS-only for `rtc` and `turn`; set SSL/TLS mode to Full (strict).

- [ ] Generate production secrets locally on the server, store them in the protected environment/secrets file, deploy, then run:

```bash
docker compose -f infra/docker-compose.yml ps
curl --fail https://meet.babagan.cloud/health/live
curl --fail https://meet.babagan.cloud/health/ready
bash scripts/smoke-test.sh https://meet.babagan.cloud wss://rtc.babagan.cloud
```

Expected: every container is healthy; both health endpoints return success; TLS, SPA and WebSocket checks pass.

- [ ] Execute manual Windows 10/11 Chrome/Edge media acceptance: five freely controlled microphones, standard 1080p30 share, motion 1080p60 share, tab/system audio guidance, aspect ratio, 10-second reconnect, UDP direct, TURN/UDP 443 and RTC/TCP 7881 paths.

- [ ] Run the two-hour load/stability test. Release gate requires CPU sustained below 80% (brief peaks below 95%), RAM at or below 1.8 GiB, first/last 30-minute average difference below 150 MiB, no OOM/restarts, no sustained disk growth or large 5xx volume, and egress below the 200 Mbps peak.

- [ ] Run security checks: rate limiting, cookie tampering, Origin/CSRF, XSS/SQL injection bodies, oversized requests, forbidden camera/data/screen publishing, revoked-token reconnect, secret scan, dependency audit and external port scan. No high-severity finding may remain.

- [ ] Perform one backup restore rehearsal and one rollback rehearsal. Record exact timestamps, commands, checksums, image digests, duration and result in the runbooks.

- [ ] Complete `docs/acceptance/initial-release.md`, link it from `README.md`, run the final local gate, and commit release evidence.

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
rg -n "T[O]DO|T[B]D|F[I]XME|C[H]ANGEME|example[-]secret" . --glob '!node_modules/**' --glob '!pnpm-lock.yaml'
git status --short
git add scripts/deploy.sh scripts/rollback.sh docs README.md
git commit -m "docs: record initial production acceptance"
```

Expected: all four pnpm commands exit `0`; placeholder scan returns no matches; only intentionally untracked local secret/evidence files remain outside Git; the acceptance document records every release gate as passed.

---

## Final Traceability Check

Before declaring implementation complete, map every requirement to evidence:

| Requirement group | Primary automated evidence | Required manual evidence |
|---|---|---|
| FR-001–005 创建/加入/容量 | API integration + Chrome/Edge E2E | Random-link and password UX review |
| FR-006–007 自由开麦/设备 | Room component tests | Five-way real voice and echo check |
| FR-008–010 唯一共享/质量 | Host race tests + share component tests | 1080p30/60 and computer-audio checks |
| FR-011–014 控制/重连/回收 | API, webhook and fake-clock tests | Real network interruption check |
| 性能 | Load script output | Two-hour target-server report |
| 安全与隐私 | Security integration tests and scans | Firewall/TLS/external port evidence |
| 运维恢复 | Backup/restore and smoke tooling | Target-server rollback rehearsal |

Implementation is complete only when `docs/acceptance/initial-release.md` contains links or file references to all evidence above and every release gate in `docs/05-test-and-acceptance.md` is satisfied.
