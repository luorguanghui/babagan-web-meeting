# 共享级 TURN 提供商选择与新服务器部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在新建的 Debian 13 ECS 上部署 Babagan，并让共享者在每次开始屏幕共享前选择服务器 coturn 或 Cloudflare TURN，同时保证共享双方使用同一 provider。

**Architecture:** 保留 P2P_TURN_PROVIDER 作为 auto 的默认 provider，扩展认证 ICE 接口支持 provider query。共享者 controller 在 offer metadata 中携带 API 实际返回的 provider，观看者收到 offer 后按 metadata 获取同 provider 的短期 ICE 凭据；Cloudflare 不可用时 API 回退 coturn，现有 LiveKit SFU 继续作为最终安全网。服务器使用现有五服务 Compose，DNS、Caddy、LiveKit、coturn 和 web 在同一新 ECS 上运行。

**Tech Stack:** React + TypeScript + Vite、Fastify + WebSocket、TypeBox、Vitest、pnpm、Docker Compose、Caddy、LiveKit、coturn、Cloudflare Realtime TURN、阿里云 ECS。

**Spec:** docs/superpowers/specs/2026-09-01-share-turn-provider-and-deployment-design.md

## Global Constraints

- 目标实例是 Debian 13.6、2 核、2 GiB、40 GiB；部署脚本必须同时接受 Debian 12 和 Debian 13。
- meet.babagan.cloud 保持 Cloudflare Proxied；rtc.babagan.cloud 与 turn.babagan.cloud 保持 DNS only。
- P2P_TURN_PROVIDER 是 auto 的默认 provider；生产环境默认 coturn，Cloudflare 凭据同时配置以开放 UI 两个选项。
- TURN API Token/Secret 只存在服务器 mode 600 的生产环境文件，不进入 Git、前端、localStorage、日志或聊天。
- 每次共享由共享者选择 provider；provider 通过已校验的 P2P offer metadata 同步给所有观看者，观看者的 Auto/TURN/SFU 偏好继续只控制传输策略。
- 保留 Caddy、API、LiveKit、coturn、web 五服务，禁止公开 TCP 3000/7880 和 Docker/coturn 管理端口。
- 只添加本任务需要的 tracked 文件；保留工作树已有未跟踪部署包、验收输出和文档，不使用清理或覆盖命令。
- 每个实现任务遵循红—绿—重构；先写一个会失败的行为测试并观察失败，再写最小实现。
- 完成声明只能依据当前回合新鲜的测试、构建、健康检查和线上验收输出。

---

### Task 1: 扩展 TURN 配置模型，允许双 provider 共存

**Files:**

- Modify: apps/api/src/config.ts
- Test: apps/api/src/config.test.ts
- Modify: infra/.env.production.example
- Test: apps/api/src/index.test.ts（只在现有配置测试需要同步类型时修改）

**Interfaces:**

- Produces AppConfig.p2pTurnProvider、cloudflareTurnKeyId、cloudflareTurnApiToken、cloudflareTurnTtlSeconds 和 cloudflareTurnConnectIps。
- P2P_TURN_PROVIDER 继续接受 coturn|cloudflare，含义是 auto 的默认 provider。
- Cloudflare Key ID 与 API Token 要么同时为空，要么同时非空；默认 provider 为 cloudflare 时必须同时非空。

- [ ] **Step 1: Write the failing tests**

在 apps/api/src/config.test.ts 的现有 Cloudflare 配置测试旁增加以下行为：

~~~ts
it('keeps optional Cloudflare credentials when coturn is the auto default', () => {
  const config = loadConfig(validEnv({
    P2P_TURN_PROVIDER: 'coturn',
    CLOUDFLARE_TURN_KEY_ID: 'turn-key-id',
    CLOUDFLARE_TURN_API_TOKEN: 'turn-api-token',
    CLOUDFLARE_TURN_TTL_SECONDS: '600'
  }));

  expect(config.p2pTurnProvider).toBe('coturn');
  expect(config.cloudflareTurnKeyId).toBe('turn-key-id');
  expect(config.cloudflareTurnApiToken).toBe('turn-api-token');
  expect(config.cloudflareTurnTtlSeconds).toBe(600);
});

it.each([
  ['CLOUDFLARE_TURN_KEY_ID', { CLOUDFLARE_TURN_API_TOKEN: 'token' }],
  ['CLOUDFLARE_TURN_API_TOKEN', { CLOUDFLARE_TURN_KEY_ID: 'key' }]
] as const)('rejects a partial Cloudflare credential pair when %s is missing', (_, overrides) => {
  expect(() => loadConfig(validEnv(overrides))).toThrow(/Cloudflare TURN.*pair|both/i);
});

it('requires Cloudflare credentials when Cloudflare is the auto default', () => {
  expect(() => loadConfig(validEnv({ P2P_TURN_PROVIDER: 'cloudflare' })))
    .toThrow(/CLOUDFLARE_TURN_KEY_ID/);
});
~~~

- [ ] **Step 2: Run the focused tests and verify the expected failure**

Run:

~~~bash
pnpm vitest run apps/api/src/config.test.ts
~~~

Expected: the coturn-with-Cloudflare test fails because the current parser discards Cloudflare-only settings when coturn is selected, and the partial-pair test fails because there is no pair validation yet.

- [ ] **Step 3: Write minimal implementation**

Update loadConfig so it reads and trims the two Cloudflare credentials independently, rejects exactly-one-present, requires the pair when P2P_TURN_PROVIDER=cloudflare, and parses TTL/connect IPs whenever the pair is present or Cloudflare is the default. Keep the current 60–86400 TTL range and IP validation. Leave coturn secrets and the existing production URL checks unchanged. Update the production example comments to show that Cloudflare values may be configured while P2P_TURN_PROVIDER=coturn remains the default.

- [ ] **Step 4: Run the focused tests and API typecheck**

~~~bash
pnpm vitest run apps/api/src/config.test.ts
pnpm --filter @meeting/api typecheck
~~~

Expected: both commands exit 0 and the output contains no failed tests or TypeScript errors.

- [ ] **Step 5: Commit the configuration slice**

~~~bash
git add apps/api/src/config.ts apps/api/src/config.test.ts infra/.env.production.example apps/api/src/index.test.ts
git commit -m "feat: allow both TURN providers in configuration"
~~~

### Task 2: Add provider-aware authenticated ICE responses

**Files:**

- Modify: apps/api/src/http/routes/ice-servers.ts
- Test: apps/api/src/http/routes/ice-servers.test.ts
- Modify: apps/web/src/meeting/p2p-ice.ts
- Test: apps/web/src/meeting/p2p-ice.test.tsx
- Modify: apps/web/src/meeting/p2p-share-controller.ts（只修改 IceServersResponseSchema）

**Interfaces:**

- Query parameter: turnProvider=auto|coturn|cloudflare。
- Response field: availableTurnProviders: P2pTurnProvider[]。
- turnProvider remains the actual provider used to create the returned iceServers.
- Cloudflare failure or unavailable credentials return a valid coturn response with turnProvider: coturn.

- [ ] **Step 1: Write failing route tests**

Extend the ICE route fixture with Cloudflare credentials while keeping P2P_TURN_PROVIDER=coturn. Add tests like:

~~~ts
it('selects Cloudflare when the authenticated request asks for it', async () => {
  const cloudflareFixture = await createFixture({
    p2pTurnProvider: 'coturn',
    cloudflareTurnKeyId: 'turn-key-id',
    cloudflareTurnApiToken: 'turn-api-token',
    cloudflareTurnTtlSeconds: 600
  });
  const fetchCloudflare = vi.fn(async () => new Response(JSON.stringify({
    iceServers: [{
      urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'opaque-user',
      credential: 'opaque-credential'
    }]
  }), { status: 201 }));
  vi.stubGlobal('fetch', fetchCloudflare);

  try {
    const created = await cloudflareFixture.createMeeting();
    const joined = await cloudflareFixture.join(created.slug, 'Ada');
    const response = await cloudflareFixture.app.inject({
      url: '/api/v1/meetings/' + created.slug + '/ice-servers?turnProvider=cloudflare',
      headers: { cookie: cookiePair(joined.headers['set-cookie']) }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      turnProvider: 'cloudflare',
      availableTurnProviders: ['coturn', 'cloudflare']
    });
    expect(fetchCloudflare).toHaveBeenCalledOnce();
  } finally {
    await cloudflareFixture.close();
  }
});

it('falls back to coturn when an explicit Cloudflare request fails', async () => {
  const cloudflareFixture = await createFixture({
    cloudflareTurnKeyId: 'turn-key-id',
    cloudflareTurnApiToken: 'turn-api-token'
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
  try {
    const created = await cloudflareFixture.createMeeting();
    const joined = await cloudflareFixture.join(created.slug, 'Ada');
    const response = await cloudflareFixture.app.inject({
      url: '/api/v1/meetings/' + created.slug + '/ice-servers?turnProvider=cloudflare',
      headers: { cookie: cookiePair(joined.headers['set-cookie']) }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().turnProvider).toBe('coturn');
  } finally {
    await cloudflareFixture.close();
  }
});
~~~

Also assert that a normal request reports availableTurnProviders without exposing either long-lived credential.

- [ ] **Step 2: Run the route tests and verify the expected failure**

~~~bash
pnpm vitest run apps/api/src/http/routes/ice-servers.test.ts
~~~

Expected: the query request is rejected or ignored because the route has no query schema/provider selection, and the response lacks availableTurnProviders.

- [ ] **Step 3: Implement provider resolution and response typing**

Add a TypeBox query schema with the three allowed values. Build the coturn response once, derive availableTurnProviders from the configuration pair, resolve auto through config.p2pTurnProvider, and call fetchCloudflareTurnIceServers only when the resolved provider is Cloudflare. Catch Cloudflare errors and return the coturn response. Preserve participant-cookie authentication, rate limiting, no-store headers, and the existing short-lived credential calculation.

Extend P2pIceServerConfiguration and both client/server TypeBox schemas with availableTurnProviders and keep it optional on the client parser for legacy responses.

- [ ] **Step 4: Verify green**

~~~bash
pnpm vitest run apps/api/src/http/routes/ice-servers.test.ts apps/web/src/meeting/p2p-ice.test.tsx
pnpm typecheck
~~~

Expected: all focused tests and the workspace typecheck pass.

- [ ] **Step 5: Commit the ICE API slice**

~~~bash
git add apps/api/src/http/routes/ice-servers.ts apps/api/src/http/routes/ice-servers.test.ts apps/web/src/meeting/p2p-ice.ts apps/web/src/meeting/p2p-ice.test.tsx apps/web/src/meeting/p2p-share-controller.ts
git commit -m "feat: select TURN provider per ICE request"
~~~

### Task 3: Carry the actual provider through P2P signaling

**Files:**

- Modify: packages/contracts/src/p2p.ts
- Test: packages/contracts/src/p2p.test.ts
- Modify: apps/web/src/meeting/p2p-signaling.ts
- Test: apps/web/src/meeting/p2p-signaling.test.tsx
- Modify: apps/api/src/p2p/signaling-session.ts
- Test: apps/api/src/http/routes/p2p-signaling.test.ts

**Interfaces:**

- Client offer shape: type offer, to, sdp, generation?, turnProvider?。
- P2pSignalingClient.sendOffer(to, sdp, generation?, turnProvider?)。
- P2pSignalingEvents.onOffer(from, sdp, generation?, turnProvider?)。
- Server forwarding continues to inject from and enforce that only the active sharer sends offers.

- [ ] **Step 1: Write failing contract and client tests**

Add a contract test that accepts a valid provider and rejects an unknown value:

~~~ts
it('accepts only known TURN providers on an offer', () => {
  expect(Value.Check(P2pClientMessageSchema, {
    type: 'offer', to: 'viewer', sdp: 'sdp', turnProvider: 'cloudflare'
  })).toBe(true);
  expect(Value.Check(P2pClientMessageSchema, {
    type: 'offer', to: 'viewer', sdp: 'sdp', turnProvider: 'unknown'
  })).toBe(false);
});
~~~

Add a signaling test that receives turnProvider: cloudflare and calls onOffer with the fourth argument, plus a send test that includes the field only when it is defined.

- [ ] **Step 2: Run focused tests to confirm red**

~~~bash
pnpm vitest run packages/contracts/src/p2p.test.ts apps/web/src/meeting/p2p-signaling.test.tsx
~~~

Expected: the schema rejects the new field and the callback assertion does not receive the provider.

- [ ] **Step 3: Implement the protocol extension**

Add an optional turnProvider TypeBox union to the offer object. Update the signaling event and send method signatures. When parsing a forwarded offer, pass the provider only if it is one of the two known values; when sending an offer, omit the property for legacy/undefined calls. The server session needs no new routing logic because it validates the client message and forwards the validated object, but add a server integration assertion that the provider survives forwarding.

- [ ] **Step 4: Verify green**

~~~bash
pnpm vitest run packages/contracts/src/p2p.test.ts apps/web/src/meeting/p2p-signaling.test.tsx apps/api/src/http/routes/p2p-signaling.test.ts
pnpm --filter @meeting/contracts build
~~~

Expected: all protocol tests pass and the contracts package builds.

- [ ] **Step 5: Commit the signaling slice**

~~~bash
git add packages/contracts/src/p2p.ts packages/contracts/src/p2p.test.ts apps/web/src/meeting/p2p-signaling.ts apps/web/src/meeting/p2p-signaling.test.tsx apps/api/src/p2p/signaling-session.ts apps/api/src/http/routes/p2p-signaling.test.ts
git commit -m "feat: synchronize TURN provider in P2P offers"
~~~

### Task 4: Make sharer and viewer use the synchronized provider

**Files:**

- Modify: apps/web/src/meeting/p2p-share-controller.ts
- Test: apps/web/src/meeting/p2p-share-controller.test.tsx
- Modify: apps/web/src/meeting/p2p-viewer-controller.ts
- Test: apps/web/src/meeting/p2p-viewer-controller.test.tsx
- Modify: apps/web/src/pages/meeting-room-page.tsx
- Test: apps/web/src/meeting/screen-share.test.tsx
- Modify: apps/web/src/meeting/p2p-ice.ts

**Interfaces:**

- P2pShareController keeps fetchIceServers: () => Promise<RTCIceServer[] | P2pIceServerConfiguration>.
- The page supplies a provider-aware fetcher for the sharer; it reads the current ScreenShareTurnProviderPreference ref and requests turnProvider unless the preference is auto.
- ViewerSignal carries turnProvider?: P2pTurnProvider.
- A sharer offer always carries the actual session.turnProvider; a legacy offer without metadata remains coturn-compatible.

- [ ] **Step 1: Write failing sharer tests**

Update the P2P share harness with a Cloudflare ICE response and assert that the created peer connection uses it and the offer includes the provider:

~~~ts
it('sends the actual TURN provider with a sharer offer', async () => {
  const sendOffer = vi.fn();
  const controller = createP2pShareController({
    slug: 'meeting-slug',
    signaling: { sendOffer, sendIce: vi.fn(), sendBye: vi.fn() },
    fetchIceServers: async () => ({
      iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' }],
      turnProvider: 'cloudflare',
      turnCredentialsExpiresAt: 9_999_999_999
    }),
    createPeerConnection: () => new FakePeerConnection()
  });

  await controller.start(displayStream().stream, shareOptions(), [
    { identity: 'viewer-1', nickname: 'Bob' }
  ]);

  expect(sendOffer).toHaveBeenCalledWith(
    'viewer-1', expect.any(String), expect.any(String), 'cloudflare'
  );
});
~~~

- [ ] **Step 2: Run the sharer tests and verify red**

~~~bash
pnpm vitest run apps/web/src/meeting/p2p-share-controller.test.tsx
~~~

Expected: the offer spy receives only the legacy three arguments and the test fails.

- [ ] **Step 3: Implement provider-aware offer creation**

Pass session.turnProvider to sendOffer in establishSession. Keep refreshIceServers, retry, timeout re-drive, and provider reporting intact so a provider fallback is reflected in the next offer.

- [ ] **Step 4: Write failing viewer synchronization test**

Add a page-level test where the viewer has initially fetched coturn, then receives a Cloudflare offer and the test resolves a second ICE request. Assert that the second request URL contains turnProvider=cloudflare and the newly created peer connection receives the Cloudflare server list.

- [ ] **Step 5: Run the viewer test to confirm red**

~~~bash
pnpm vitest run apps/web/src/meeting/screen-share.test.tsx
~~~

Expected: the viewer uses the cached coturn configuration instead of fetching the provider carried by the offer.

- [ ] **Step 6: Implement keyed viewer ICE refresh**

In MeetingRoomPage, key the in-flight ICE request by requested provider. Record availableTurnProviders from every response. On a provider-carrying offer, refresh if the cached config is missing, expiring, or has a different actual provider; wait for that request before calling acceptOffer. Keep sfu preference short-circuiting and the existing retry/fallback state machine. The initial page request remains auto and therefore also discovers available providers.

When constructing the sharer controller, inject a fetcher that builds the encoded query from the current screen-share provider ref. Keep the selector disabled once screenState.status is starting or sharing, so the provider is stable for the active share.

- [ ] **Step 7: Run the complete WebRTC-focused tests**

~~~bash
pnpm vitest run apps/web/src/meeting/p2p-share-controller.test.tsx apps/web/src/meeting/p2p-viewer-controller.test.tsx apps/web/src/meeting/screen-share.test.tsx apps/web/src/meeting/p2p-ice.test.tsx
~~~

Expected: all existing and new tests pass, including Cloudflare labels and coturn fallback behavior.

- [ ] **Step 8: Commit the synchronization slice**

~~~bash
git add apps/web/src/meeting/p2p-share-controller.ts apps/web/src/meeting/p2p-share-controller.test.tsx apps/web/src/meeting/p2p-viewer-controller.ts apps/web/src/meeting/p2p-viewer-controller.test.tsx apps/web/src/pages/meeting-room-page.tsx apps/web/src/meeting/screen-share.test.tsx apps/web/src/meeting/p2p-ice.ts
git commit -m "feat: align P2P peers on the selected TURN provider"
~~~

### Task 5: Add persisted screen-share provider preference and UI

**Files:**

- Create: apps/web/src/meeting/screen-turn-provider-preference.ts
- Test: apps/web/src/meeting/screen-turn-provider-preference.test.tsx
- Modify: apps/web/src/components/meeting-controls.tsx
- Test: apps/web/src/meeting/screen-share.test.tsx
- Modify: apps/web/src/pages/meeting-room-page.tsx
- Modify: apps/web/src/i18n/i18n.tsx
- Modify: apps/web/src/styles.css only if the new hint needs a dedicated layout rule

**Interfaces:**

- ScreenShareTurnProviderPreference = auto | coturn | cloudflare。
- readScreenShareTurnProviderPreference(storage?: Storage): ScreenShareTurnProviderPreference。
- saveScreenShareTurnProviderPreference(storage: Storage, preference): void。
- MeetingControlsProps gains screenShareTurnProvider, availableTurnProviders, screenShareTurnProviderVisible and onScreenShareTurnProviderChange.

- [ ] **Step 1: Write failing preference tests**

~~~ts
it('defaults to auto and ignores unsupported persisted values', () => {
  localStorage.setItem('babagan.screen-turn-provider', 'invalid');
  expect(readScreenShareTurnProviderPreference(localStorage)).toBe('auto');
});

it.each(['auto', 'coturn', 'cloudflare'] as const)('persists %s', (preference) => {
  saveScreenShareTurnProviderPreference(localStorage, preference);
  expect(readScreenShareTurnProviderPreference(localStorage)).toBe(preference);
});
~~~

- [ ] **Step 2: Run preference tests and verify red**

~~~bash
pnpm vitest run apps/web/src/meeting/screen-turn-provider-preference.test.tsx
~~~

Expected: the module is missing and Vitest reports the import/function failure.

- [ ] **Step 3: Implement the small storage module**

Use the key babagan.screen-turn-provider, accept only the three union values, catch storage errors, and return auto on missing or invalid input.

- [ ] **Step 4: Add failing controls test**

Render MeetingControls with a visible provider selector and both available providers. Assert the three option labels exist, changing to cloudflare calls the callback, and rerendering with screenShareActive disables the selector. Render with only ['coturn'] and assert that the Cloudflare option is absent.

- [ ] **Step 5: Run the controls test and verify red**

~~~bash
pnpm vitest run apps/web/src/meeting/screen-share.test.tsx
~~~

Expected: the new provider selector cannot be found because the props and settings field do not exist.

- [ ] **Step 6: Implement the UI and page state**

Add English and Simplified Chinese messages for the provider label, Auto, server coturn, Cloudflare TURN, and the hint that provider selection applies to the current share and is controlled by the sharer. Put the selector in MeetingSettings beside the screen quality/codec fields; use native select and existing form/grid styles. Pass the page state/ref, discovered providers, visibility, persistence callback, and disabled state through meetingControlsProps. Keep the existing viewer transport selector separate and unchanged.

- [ ] **Step 7: Verify green and run accessibility tests**

~~~bash
pnpm vitest run apps/web/src/meeting/screen-turn-provider-preference.test.tsx apps/web/src/meeting/screen-share.test.tsx apps/web/src/accessibility.test.tsx
pnpm --filter @meeting/web typecheck
~~~

Expected: selector, translations, accessibility, and web typecheck pass without warnings.

- [ ] **Step 8: Commit the UI slice**

~~~bash
git add apps/web/src/meeting/screen-turn-provider-preference.ts apps/web/src/meeting/screen-turn-provider-preference.test.tsx apps/web/src/components/meeting-controls.tsx apps/web/src/meeting/screen-share.test.tsx apps/web/src/pages/meeting-room-page.tsx apps/web/src/i18n/i18n.tsx apps/web/src/styles.css
git commit -m "feat: add screen-share TURN provider selector"
~~~

### Task 6: Harden deployment scripts and provider smoke coverage

**Files:**

- Modify: scripts/deploy.sh
- Modify: scripts/deployment-smoke.sh
- Modify: scripts/smoke-test.sh
- Test: scripts/deployment-smoke.test.sh
- Test: scripts/smoke-test.provider.test.sh
- Test: scripts/deployment-scripts.test.sh

**Interfaces:**

- deploy.sh accepts Debian 12 or Debian 13.
- SMOKE_REQUESTED_TURN_PROVIDER=auto|coturn|cloudflare asks smoke-test.sh to add the matching turnProvider query; auto preserves the current default request.
- deployment-smoke.sh runs the normal/default smoke, then explicit coturn and Cloudflare ICE checks when both Cloudflare credential keys are present in the protected env file.

- [ ] **Step 1: Write failing shell regression assertions**

Add to scripts/deployment-scripts.test.sh:

~~~bash
need "$deploy" 'VERSION_ID'
need "$smoke" 'SMOKE_REQUESTED_TURN_PROVIDER'
need "$deployment_smoke" 'SMOKE_REQUESTED_TURN_PROVIDER=cloudflare'
~~~

Extend scripts/smoke-test.provider.test.sh so the mocked curl requires the query-specific ICE URL and the test invokes SMOKE_REQUESTED_TURN_PROVIDER=cloudflare.

- [ ] **Step 2: Run shell regressions and verify red**

~~~bash
bash scripts/deployment-scripts.test.sh
bash scripts/smoke-test.provider.test.sh
~~~

Expected: the new guard strings are missing and the provider smoke cannot request the query-specific URL.

- [ ] **Step 3: Implement Debian 13 and query-aware smoke logic**

Change the deploy OS guard to accept only Debian 12.* or 13.*, retain every other preflight, and keep the error message explicit. In smoke-test.sh, validate SMOKE_REQUESTED_TURN_PROVIDER, append turnProvider query for an explicit request, and compare the response against the requested provider. For Cloudflare, require the Cloudflare STUN/TURN URL and an opaque username; for coturn, require the configured STUN/TURN URL and an expiry-style username. Never print the response body.

In deployment-smoke.sh, detect the presence of both Cloudflare env entries without printing their values and run the explicit smoke call after the default call. The wrapper must retain its trap that deletes the disposable meeting even if either smoke call fails.

- [ ] **Step 4: Update shell mocks and verify green**

~~~bash
bash scripts/deployment-smoke.test.sh
bash scripts/smoke-test.provider.test.sh
bash scripts/deployment-scripts.test.sh
bash -n scripts/deploy.sh scripts/deployment-smoke.sh scripts/smoke-test.sh
~~~

Expected: all scripts parse and all shell regression tests pass.

- [ ] **Step 5: Commit the deployment-script slice**

~~~bash
git add scripts/deploy.sh scripts/deployment-smoke.sh scripts/smoke-test.sh scripts/deployment-smoke.test.sh scripts/smoke-test.provider.test.sh scripts/deployment-scripts.test.sh
git commit -m "test: verify dual TURN provider deployment paths"
~~~

### Task 7: Align documentation and perform complete local release verification

**Files:**

- Modify: README.md
- Modify: docs/02-technical-architecture.md
- Modify: docs/03-implementation-specification.md
- Modify: docs/04-deployment-and-operations.md
- Modify: docs/05-test-and-acceptance.md
- Modify: docs/runbooks/deployment-record.md
- Modify: docs/runbooks/rollback-record.md
- Modify: infra/compose-config.test.mjs only if the new optional env validation needs coverage

- [ ] **Step 1: Capture the documentation baseline**

Before editing, run the following focused search and record which required terms are absent; the existing documentation files are the regression surface for this task, so no new test harness is needed:

~~~bash
rg -n "Debian 13|turnProvider|CLOUDFLARE_TURN_API_TOKEN|meet.*Proxied|rtc.*DNS[- ]only|turn.*DNS[- ]only|SMOKE_REQUESTED_TURN_PROVIDER" README.md docs scripts
~~~

Keep actual secrets and instance IPs out of the committed docs.

- [ ] **Step 2: Run documentation checks and observe red**

~~~bash
rg -n "Debian 13|turnProvider|Cloudflare.*TURN|coturn.*Cloudflare" docs README.md
~~~

Expected: the current deployment guide still says Debian 12-only and describes only the environment-level provider switch.

- [ ] **Step 3: Update the docs**

Document the share-level selector, provider synchronization, fallback semantics, server-only secrets, Debian 13 support, dual-provider production env shape, the existing Cloudflare v2/new v3 decision, DNS cutover order, security-group/UFW ports, and recovery steps. Keep the runbook evidence strings aligned with the actual script arguments.

- [ ] **Step 4: Run the complete local quality gate**

~~~bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
bash scripts/http-headers.test.sh
bash scripts/deployment-smoke.test.sh
bash scripts/deployment-scripts.test.sh
bash scripts/smoke-test.provider.test.sh
git diff --check
~~~

Expected: every command exits 0; if any fails, fix the code/test/docs and rerun the full affected command before proceeding.

- [ ] **Step 5: Inspect release state and commit docs**

~~~bash
git status --short
git log -1 --oneline
git add README.md docs/02-technical-architecture.md docs/03-implementation-specification.md docs/04-deployment-and-operations.md docs/05-test-and-acceptance.md docs/runbooks/deployment-record.md docs/runbooks/rollback-record.md infra/compose-config.test.mjs
git commit -m "docs: document share-level TURN deployment"
~~~

The status review must show only the intended tracked changes staged for this commit; leave pre-existing untracked files untouched.

### Task 8: Prepare the target host and Cloudflare resources

**Systems:**

- Target ECS terminal session for package installation, repository, protected env and firewall.
- Cloudflare babagan.cloud DNS records and Realtime TURN app.
- Aliyun ECS security group sg-2zebht21e4zor6h1gvc6.

**Inputs:**

- Target public IPv4: the ECS value already read from the console, 39.106.36.145.
- Target private relay IPv4: the ECS value already read from the console, 172.19.196.130.
- App directory: /opt/babagan-meeting.
- Public host: meet.babagan.cloud; RTC host: rtc.babagan.cloud; TURN host: turn.babagan.cloud.

- [ ] **Step 1: Re-check the host before mutation**

In the open Shell terminal run the read-only checks:

~~~bash
cat /etc/os-release
df -h /
free -h
hostname -I
docker version || true
docker compose version || true
ss -lntup
~~~

Expected: Debian 13, at least 1.1 GiB available memory, at least 10 GiB free disk, only SSH listening, and no Babagan containers.

- [ ] **Step 2: Install host dependencies**

Use the current official Docker Engine installation path for Debian 13, then install git, sqlite3, curl, iproute2, openssl, ufw, and ca-certificates. Enable Docker and verify docker version and docker compose version. Do not install a standalone coturn systemd service; coturn will run only in Compose.

- [ ] **Step 3: Update the Aliyun security group**

Add inbound rules for TCP 80,443,3478,5349,7881 and UDP 443,3478,49160-49200,50000-60000. Keep the existing SSH rule to avoid locking the active Workbench session and retain the existing RDP rule unless the console requires a separate cleanup decision. Do not add 3000 or 7880.

- [ ] **Step 4: Configure UFW safely**

Run the following with SSH explicitly allowed before enabling the firewall:

~~~bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3478/tcp
ufw allow 5349/tcp
ufw allow 7881/tcp
ufw allow 443/udp
ufw allow 3478/udp
ufw allow 49160:49200/udp
ufw allow 50000:60000/udp
ufw --force enable
ufw status verbose
~~~

- [ ] **Step 5: Prepare and upload the tested release bundle**

After the local quality gate, create a full Git bundle from the tested HEAD and checksum it:

~~~bash
RELEASE_SHA=$(git rev-parse HEAD)
git bundle create "babagan-deploy-$RELEASE_SHA.bundle" --all
git bundle verify "babagan-deploy-$RELEASE_SHA.bundle"
sha256sum "babagan-deploy-$RELEASE_SHA.bundle"
~~~

Transfer that bundle to /root/babagan-protected/ through the active server terminal without putting secrets in it. On the server, verify the checksum, clone the bundle into /opt/babagan-meeting, and check out exactly RELEASE_SHA detached.

- [ ] **Step 6: Switch Cloudflare DNS records**

In the visible Cloudflare DNS table, edit only the meet, rtc, and turn A records from the old origin to 39.106.36.145, preserving Proxied for meet and DNS only for rtc/turn. Leave the root A record unchanged. Verify the table after each save and rerun getent ahostsv4 on the ECS.

- [ ] **Step 7: Obtain Cloudflare TURN credentials**

Check whether the existing babagan-turn-production-v2 secret can be obtained from a protected source. If not, create babagan-turn-production-v3 in the visible Cloudflare Realtime TURN page, keep v2, and capture the one-time Key ID/API Token result directly into the server’s protected env editing flow. At the exact moment before creating the new app or entering the long-lived token into the server, request the required action-time confirmation; never paste it into chat.

### Task 9: Bootstrap, deploy and verify the new production stack

**Systems:**

- Target /opt/babagan-meeting/infra/.env.production and /root/babagan-secrets/*.
- Target Docker Compose stack and Caddy data volume.
- Cloudflare and Aliyun state changed in Task 8.

- [ ] **Step 1: Create protected production secrets on the server**

Create mode-700 secret/protected directories and mode-600 files. Generate COOKIE_SECRET, P2P_TURN_SECRET, TURN_SHARED_SECRET, LiveKit API key/secret, and a one-time admin password entirely on the server. Set the same random value for P2P_TURN_SECRET and TURN_SHARED_SECRET; set LIVEKIT_NODE_IP and TURN_EXTERNAL_IP to 39.106.36.145, TURN_RELAY_IP to 172.19.196.130, and P2P_TURN_PROVIDER=coturn. Enter the Cloudflare Key ID/API Token only after the action-time confirmation from Task 8.

- [ ] **Step 2: Generate the Argon2id admin hash without printing the password**

Build the API bootstrap image, store the chosen/generated password in /root/babagan-secrets/admin-password mode 600, run the documented offline container command with Argon2id parameters memoryCost=65536,timeCost=3,parallelism=1, write the hash to /root/babagan-secrets/admin-password-hash, place only the hash in infra/.env.production, then remove the plaintext secret file. Keep the one-time password available to the user through the protected terminal workflow, not in Git or chat.

- [ ] **Step 3: Start Caddy for certificate issuance**

Run Caddy alone with the production env, wait for certificates for meet.babagan.cloud, rtc.babagan.cloud, and turn.babagan.cloud, apply only the documented coturn-readable certificate permissions, add the Docker bridge-to-host 7880 UFW rule, and stop/remove only the preflight Caddy container before the guarded deploy.

- [ ] **Step 4: Create evidence files and run the guarded bootstrap**

Create network.txt, cloudflare.txt, and a fresh mode-600 smoke token. Confirm there is no current-release.env, no pending release, no existing API data volume, and no running managed stack. Run:

~~~bash
cd /opt/babagan-meeting
RELEASE_SHA=$(git rev-parse HEAD)
sudo bash scripts/deploy.sh \
  --confirm-deploy "$RELEASE_SHA" \
  --target-ip 39.106.36.145 \
  --smoke-token-file /root/babagan-secrets/smoke-token \
  --network-evidence /root/babagan-protected/network.txt \
  --cloudflare-evidence /root/babagan-protected/cloudflare.txt \
  --bootstrap-empty
~~~

- [ ] **Step 5: Verify the guarded deployment result**

Run on the server:

~~~bash
docker compose --env-file infra/.env.production -f infra/docker-compose.yml ps
curl --fail --silent --show-error https://meet.babagan.cloud/health/live
curl --fail --silent --show-error https://meet.babagan.cloud/health/ready
curl --silent --output /dev/null --write-out '%{http_code}\n' https://meet.babagan.cloud/
sed -n '1,32p' var/releases/current-release.env
test ! -e var/releases/pending-release.env
~~~

Expected: Caddy/API/LiveKit/coturn/web are healthy, health responses are status ok and status ready, homepage is HTTP 200, release provenance is recorded, and no pending file remains.

- [ ] **Step 6: Verify both authenticated ICE providers without leaking secrets**

Use the deployment smoke’s disposable meeting/cookie or create a fresh one. Request the default endpoint and explicit turnProvider=coturn and turnProvider=cloudflare. Check only status, turnProvider, expected public ICE URLs, short-lived username/credential presence, and Cache-Control: no-store; redirect response bodies containing credentials to protected temporary files and delete them after checking.

- [ ] **Step 7: Verify public exposure and real meeting behavior**

From a separate network or the browser, check that TCP 3000/7880 are blocked while required public ports are reachable. Open https://meet.babagan.cloud, create a disposable meeting, join with two browser contexts, verify screen sharing with provider 服务器 coturn, then end the share and repeat with Cloudflare TURN. In the WebRTC diagnostics, confirm the displayed provider matches the actual TURN path; switch the viewer to SFU and confirm the existing LiveKit fallback still works. Close all disposable meetings.

- [ ] **Step 8: Record evidence and preserve rollback**

Record only deployment SHA, image IDs, health results, DNS proxy modes, security-group/UFW rule evidence, provider labels and smoke status in the runbook. Do not record passwords, tokens, SDP, ICE candidates, participant data or media. Keep the old origin and DNS rollback values until the new stack has completed the observation period.

### Task 10: Final independent verification and handoff

- [ ] **Step 1: Run fresh local verification after all commits**

~~~bash
git diff --check
git status --short --branch
pnpm lint
pnpm typecheck
pnpm test
pnpm build
bash scripts/http-headers.test.sh
bash scripts/deployment-smoke.test.sh
bash scripts/deployment-scripts.test.sh
bash scripts/smoke-test.provider.test.sh
~~~

- [ ] **Step 2: Inspect the final diff and release commit**

~~~bash
git diff origin/codex/receiver-audio-volume...HEAD --stat
git log --oneline --decorate -12
~~~

Confirm the diff contains only the approved provider-selection/deployment work and the committed spec/plan; existing untracked artifacts remain unmodified.

- [ ] **Step 3: Hand off exact production facts**

Report the public URL, deployed SHA, actual default provider, both provider availability, health/smoke result, how to change the provider in the share settings, and the protected path for any locally retained credentials. Do not include secret values in the response.
