# P2P Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make P2P screen sharing production-safe by using supported STUN configuration, verified direct-media readiness, a persistent LiveKit safety net, seamless fallback, strict WebSocket origin checks, lifecycle cleanup, and privacy-safe diagnostics.

**Architecture:** LiveKit screen publication starts first and remains available for legacy and fallback viewers. A new client disables only its own SFU screen subscription after a direct P2P candidate pair, first decoded video frame, and growing RTP counters are confirmed; fallback reverses that order and keeps the old P2P frame until the SFU first frame. Fastify provides authenticated configured STUN servers and relays a `media-ready` confirmation while enforcing meeting/share direction and trusted Origin.

**Tech Stack:** TypeScript, React, Fastify, `@fastify/websocket`, LiveKit Web SDK, native WebRTC, TypeBox, Vitest, Testing Library, Playwright, pnpm.

## Global Constraints

- Work only in `.worktrees/meeting-implementation` on `feature/p2p-screen-share-hybrid`; keep `stash@{0}` intact as the recoverable pre-fix worktree snapshot.
- No production code change without a test that was first observed failing for the intended behavior.
- LiveKit Server remains pinned to `livekit/livekit-server:v1.11.0@sha256:100b9a870616d02f5e3795b34e0b593b5054a26f8131a94fd3fa322ed3154b16`; `livekit-client` remains 2.21.0 and `livekit-server-sdk` remains 2.17.0. Do not call undocumented `/rtc/ice` or reuse embedded LiveKit TURN credentials.
- A P2P success requires a non-relay selected candidate pair, a rendered video frame, and growing inbound RTP; ICE connected alone is insufficient.
- LiveKit screen publication remains active for the lifetime of a share; only compatible viewers may unsubscribe their own SFU screen publications.
- On fallback, subscribe and render the SFU first frame before closing or clearing P2P media.
- Do not log SDP, ICE candidates, credentials, complete IP addresses, or automatically upload quality statistics without explicit consent.
- Keep the existing limits: one sharer, at most five meeting participants, 8-second negotiation timeout, 5-second disconnect timeout, and 5-second RTP-stall timeout.

---

### Task 1: Replace the unsupported LiveKit ICE call with validated STUN configuration

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/config.test.ts`
- Modify: `apps/api/src/http/routes/ice-servers.ts`
- Modify: `apps/api/src/http/routes/ice-servers.test.ts`
- Modify: `apps/api/src/livekit/media-service.ts`
- Modify: `apps/api/src/livekit/livekit-media-service.ts`
- Modify: `apps/api/test/livekit.test.ts`
- Modify: `apps/api/test/fakes/fake-media-service.ts`
- Modify: `.env.example`
- Modify: `infra/.env.production.example`
- Modify: `infra/docker-compose.yml`

**Interfaces:**
- Produces: `AppConfig.p2pStunUrls: string[]` and `GET /api/v1/meetings/:slug/ice-servers -> { iceServers: [{ urls: string[] }] }`.
- Removes: `MediaService.fetchIceServers()`, `P2P_ICE_CACHE_TTL_SECONDS`, the LiveKit `fetchImpl` option, ICE cache, token generation, and `/rtc/ice` parsing.

- [ ] **Step 1: Write configuration and route tests that fail on the current implementation**

```ts
it('parses configured STUN URLs and rejects TURN or HTTP URLs', () => {
  expect(loadConfig(validEnv({ P2P_STUN_URLS: 'stun:stun1.example:3478,stuns:stun2.example:5349' })).p2pStunUrls)
    .toEqual(['stun:stun1.example:3478', 'stuns:stun2.example:5349']);
  expect(() => loadConfig(validEnv({ P2P_STUN_URLS: 'turn:relay.example:3478' })))
    .toThrow('P2P_STUN_URLS must contain only stun: or stuns: URLs');
});

it('returns configured STUN servers without calling LiveKit', async () => {
  const response = await joinedRequest('/ice-servers');
  expect(response.json()).toEqual({ iceServers: [{ urls: ['stun:stun1.example:3478'] }] });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @meeting/api test -- src/config.test.ts src/http/routes/ice-servers.test.ts test/livekit.test.ts`

Expected: failures because `p2pStunUrls` is absent and the route calls `media.fetchIceServers()`.

- [ ] **Step 3: Implement minimal validated configuration and route response**

```ts
function parseStunUrls(env: Environment): string[] {
  const raw = requireValue(env, 'P2P_STUN_URLS');
  const urls = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (urls.length === 0 || urls.some((value) => !/^stuns?:/i.test(value))) {
    throw new Error('P2P_STUN_URLS must contain only stun: or stuns: URLs');
  }
  return urls;
}

// ice-servers route
return { iceServers: [{ urls: dependencies.config.p2pStunUrls }] };
```

Remove the LiveKit ICE method and adjust all fakes/buildApp dependencies to use `config` only.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --filter @meeting/api test -- src/config.test.ts src/http/routes/ice-servers.test.ts test/livekit.test.ts`

Expected: all selected tests pass and no test constructs `fetchImpl` for ICE.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/config.ts apps/api/src/config.test.ts apps/api/src/http/routes/ice-servers.ts apps/api/src/http/routes/ice-servers.test.ts apps/api/src/livekit/media-service.ts apps/api/src/livekit/livekit-media-service.ts apps/api/test/livekit.test.ts apps/api/test/fakes/fake-media-service.ts .env.example infra/.env.production.example infra/docker-compose.yml packages/contracts/src/p2p.ts
git commit -m "fix(api): use configured stun servers for p2p"
```

### Task 2: Enforce trusted Origin on the WebSocket upgrade

**Files:**
- Modify: `apps/api/src/http/routes/p2p-signaling.ts`
- Modify: `apps/api/src/http/routes/p2p-signaling.test.ts`

**Interfaces:**
- Consumes: `assertTrustedOrigin(request, dependencies.publicBaseUrl)` from `apps/api/src/http/origin.ts`.
- Produces: `P2pSignalingDependencies.publicBaseUrl: URL`; missing or cross-site Origin receives HTTP 403 before Cookie authentication or upgrade.

- [ ] **Step 1: Add failing handshake integration cases**

```ts
it.each([
  ['missing Origin', undefined],
  ['cross-site Origin', 'https://evil.example']
])('rejects %s before websocket upgrade', async (_name, origin) => {
  const result = await openP2pSocket({ cookie: viewer.cookie, origin });
  expect(result.statusCode).toBe(403);
});

it('accepts the configured meeting Origin', async () => {
  const socket = await openP2pSocket({ cookie: viewer.cookie, origin: fixture.publicBaseUrl.origin });
  expect(await nextMessage(socket)).toMatchObject({ type: 'welcome' });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @meeting/api test -- src/http/routes/p2p-signaling.test.ts`

Expected: the cross-site case upgrades because the global modifying-method hook ignores GET.

- [ ] **Step 3: Validate Origin in the route's pre-upgrade hook**

```ts
onRequest: async (request) => {
  assertTrustedOrigin(request, dependencies.publicBaseUrl);
  request.p2pAuth = authenticateP2pHandshake(request, dependencies.participants, slug(request.params));
}
```

Pass `config.publicBaseUrl` from `buildApp` in the route dependency object.

- [ ] **Step 4: Run and verify GREEN**

Run: `pnpm --filter @meeting/api test -- src/http/routes/p2p-signaling.test.ts`

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/http/routes/p2p-signaling.ts apps/api/src/http/routes/p2p-signaling.test.ts apps/api/src/app.ts
git commit -m "fix(api): validate p2p websocket origin"
```

### Task 3: Add viewer media-ready signaling and prevent premature P2P success

**Files:**
- Modify: `packages/contracts/src/p2p.ts`
- Modify: `packages/contracts/src/p2p.test.ts`
- Modify: `apps/api/src/p2p/signaling-session.ts`
- Modify: `apps/api/src/p2p/signaling-session.test.ts`
- Modify: `apps/web/src/meeting/p2p-signaling.ts`
- Modify: `apps/web/src/meeting/p2p-signaling.test.tsx`
- Modify: `apps/web/src/meeting/p2p-share-controller.ts`
- Modify: `apps/web/src/meeting/p2p-share-controller.test.tsx`

**Interfaces:**
- Adds client message `{ type: 'media-ready'; to: string }`.
- Adds `P2pSignalingEvents.onMediaReady(from: string): void`, `P2pSignalingClient.sendMediaReady(to: string): void`, and `P2pShareController.handleMediaReady(from: string): void`.
- Keeps sharer session in `negotiating` on ICE connected/completed; only `handleMediaReady` transitions it to `p2p`.

- [ ] **Step 1: Add failing contract and direction tests**

```ts
expect(parseP2pClientMessage({ type: 'media-ready', to: 'sharer' }))
  .toEqual({ type: 'media-ready', to: 'sharer' });

it('forwards media-ready only from a viewer to the current sharer', () => {
  viewer.handleMessage(JSON.stringify({ type: 'media-ready', to: 'sharer' }));
  expect(sharerSocket.messages.at(-1)).toEqual(expect.stringContaining('media-ready'));
  sharer.handleMessage(JSON.stringify({ type: 'media-ready', to: 'viewer' }));
  expect(sharerSocket.messages.at(-1)).toEqual(expect.stringContaining('P2P_FORBIDDEN'));
});
```

- [ ] **Step 2: Add the failing controller behavior test and run RED**

```ts
it('does not mark a viewer p2p until media-ready arrives', async () => {
  await controller.start(stream, 8_000_000, [viewer]);
  pc.setIceState('connected');
  expect(controller.getViewerStates().get(viewer.identity)).toBe('negotiating');
  controller.handleMediaReady(viewer.identity);
  expect(controller.getViewerStates().get(viewer.identity)).toBe('p2p');
});
```

Run: `pnpm --filter @meeting/contracts test -- src/p2p.test.ts && pnpm --filter @meeting/api test -- src/p2p/signaling-session.test.ts && pnpm --filter @meeting/web test -- src/meeting/p2p-signaling.test.tsx src/meeting/p2p-share-controller.test.tsx`

Expected: schema rejects `media-ready`, signaling lacks the method, and ICE connected currently marks P2P.

- [ ] **Step 3: Implement the protocol and state transition**

```ts
// contract union
Type.Object({ type: Type.Literal('media-ready'), to: IdentitySchema }, { additionalProperties: false })

// signaling-session dispatch
case 'media-ready':
  if (this.getShareIdentity() !== message.to || this.identity === message.to) {
    this.sendError('P2P_FORBIDDEN', 'Only a viewer may confirm media to the screen sharer');
    return;
  }
  this.forward(message);
  return;

// sharer controller
handleMediaReady(identity: string): void {
  const session = this.sessions.get(identity);
  if (!session || session.state !== 'negotiating' || !session.transportConnected) return;
  this.clearTimers(session);
  this.transition(session, 'p2p');
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the three commands from Step 2; expected all selected tests pass.

- [ ] **Step 5: Commit**

```powershell
git add packages/contracts/src/p2p.ts packages/contracts/src/p2p.test.ts apps/api/src/p2p/signaling-session.ts apps/api/src/p2p/signaling-session.test.ts apps/web/src/meeting/p2p-signaling.ts apps/web/src/meeting/p2p-signaling.test.tsx apps/web/src/meeting/p2p-share-controller.ts apps/web/src/meeting/p2p-share-controller.test.tsx
git commit -m "fix(p2p): confirm viewer media before direct state"
```

### Task 4: Verify direct media health continuously and preserve P2P during fallback

**Files:**
- Create: `apps/web/src/meeting/p2p-media-health.ts`
- Create: `apps/web/src/meeting/p2p-media-health.test.ts`
- Modify: `apps/web/src/meeting/p2p-viewer-controller.ts`
- Modify: `apps/web/src/meeting/p2p-viewer-controller.test.tsx`

**Interfaces:**
- Produces: `inspectP2pMediaHealth(report: RTCStatsReport): { direct: boolean; bytesReceived: number; framesDecoded: number }`.
- Adds `P2P_RTP_STALL_TIMEOUT_MS = 5000` to contracts and a 1-second injectable sampling interval.
- Adds viewer callbacks `onP2pReady(stream)`, `onFallbackRequested(complete)`, where `complete()` closes P2P only after the caller renders SFU.

- [ ] **Step 1: Write pure stats-classification tests and verify RED**

```ts
it('accepts a growing srflx-to-host pair and rejects relay', () => {
  expect(inspectP2pMediaHealth(reportWithPair('srflx', 'host', 1200, 3))).toEqual({
    direct: true, bytesReceived: 1200, framesDecoded: 3
  });
  expect(inspectP2pMediaHealth(reportWithPair('relay', 'host', 1200, 3)).direct).toBe(false);
});
```

Run: `pnpm --filter @meeting/web test -- src/meeting/p2p-media-health.test.ts`

Expected: module does not exist.

- [ ] **Step 2: Implement the minimal stats classifier and verify GREEN**

Read the selected succeeded/nominated candidate-pair, resolve its local/remote candidates, sum non-remote video `inbound-rtp` bytes and decoded frames, and return `direct: false` if either candidate type is `relay` or no selected pair exists.

Run: `pnpm --filter @meeting/web test -- src/meeting/p2p-media-health.test.ts`

- [ ] **Step 3: Add failing viewer tests for readiness, RTP stall, relay, and deferred close**

```ts
it('signals media-ready only after direct RTP and a decoded frame', async () => {
  await controller.acceptOffer('sharer', offer);
  pc.emitTrack(videoTrack);
  pc.stats = directStats({ bytesReceived: 1000, framesDecoded: 1 });
  await advanceHealthSample();
  expect(signaling.mediaReady).toEqual(['sharer']);
  expect(controller.getState()).toBe('p2p');
});

it('requests fallback after five seconds without RTP growth but keeps the pc open until complete', async () => {
  await establishHealthyP2p();
  pc.stats = directStats({ bytesReceived: 1000, framesDecoded: 1 });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(onFallbackRequested).toHaveBeenCalledOnce();
  expect(pc.closed).toBe(false);
  onFallbackRequested.mock.calls[0][0]();
  expect(pc.closed).toBe(true);
});
```

- [ ] **Step 4: Run viewer tests and verify RED**

Run: `pnpm --filter @meeting/web test -- src/meeting/p2p-viewer-controller.test.tsx`

Expected: current controller transitions on the first unmuted track, has no stats loop, and closes immediately in `fallback()`.

- [ ] **Step 5: Implement health sampling and two-phase fallback**

Start the sampler after answer creation. Transition to `p2p` and call `sendMediaReady` only when video exists, `framesDecoded > 0`, counters have grown, and `direct` is true. Store the last-progress timestamp; request fallback after five seconds without growth. `requestFallback()` changes state to `livekit` but leaves `stream` and PC intact; the supplied completion callback performs final close and stream cleanup idempotently.

- [ ] **Step 6: Run focused tests and commit**

Run: `pnpm --filter @meeting/web test -- src/meeting/p2p-media-health.test.ts src/meeting/p2p-viewer-controller.test.tsx`

```powershell
git add packages/contracts/src/p2p.ts apps/web/src/meeting/p2p-media-health.ts apps/web/src/meeting/p2p-media-health.test.ts apps/web/src/meeting/p2p-viewer-controller.ts apps/web/src/meeting/p2p-viewer-controller.test.tsx
git commit -m "fix(web): monitor p2p media and defer fallback close"
```

### Task 5: Keep LiveKit as the safety net and hand over subscriptions without black frames

**Files:**
- Modify: `apps/web/src/meeting/room-controller.ts`
- Modify: `apps/web/src/meeting/room.test.tsx`
- Modify: `apps/web/src/meeting/screen-share.ts`
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Create: `apps/web/src/pages/meeting-room-page.test.tsx`
- Modify: `apps/web/src/components/screen-stage.tsx`
- Modify: `apps/web/src/components/screen-stage.test.tsx`

**Interfaces:**
- Adds `MeetingRoomController.setRemoteScreenShareSubscribed(subscribed: boolean): Promise<void>`.
- Changes `HybridScreenSharePublisher`: publish SFU first, keep it published until stop, and never synchronize publication to viewer P2P states.
- Meeting page on P2P-ready calls `setRemoteScreenShareSubscribed(false)` only after P2P first frame; fallback calls it with `true`, waits for the LiveKit screen first-frame signal, switches stage source, then invokes the viewer controller completion callback.

- [ ] **Step 1: Add a failing room-controller subscription test**

```ts
it('toggles every remote screen video and audio publication', async () => {
  await controller.setRemoteScreenShareSubscribed(false);
  expect(screenVideo.isSubscribed).toBe(false);
  expect(screenAudio.isSubscribed).toBe(false);
  await controller.setRemoteScreenShareSubscribed(true);
  expect(screenVideo.isSubscribed).toBe(true);
  expect(screenAudio.isSubscribed).toBe(true);
});
```

Run: `pnpm --filter @meeting/web test -- src/meeting/room.test.tsx`

Expected: method is absent.

- [ ] **Step 2: Implement subscription toggling and verify GREEN**

Iterate `room.remoteParticipants`, select publications whose source is `Track.Source.ScreenShare` or `Track.Source.ScreenShareAudio`, and await `publication.setSubscribed(subscribed)` when present. Refresh room state after enabling subscriptions.

- [ ] **Step 3: Add failing hybrid-publisher safety-net tests**

```ts
it('publishes LiveKit before P2P and keeps it published after every viewer becomes p2p', async () => {
  await hybrid.publish(stream, options);
  expect(order).toEqual(['livekit-publish', 'p2p-start']);
  controller.triggerStates([['viewer', 'p2p']]);
  await flushPromises();
  expect(livekit.release).not.toHaveBeenCalled();
});

it('rejects and cleans up when the LiveKit safety net cannot publish', async () => {
  livekit.publish.mockRejectedValue(new Error('network'));
  await expect(hybrid.publish(stream, options)).rejects.toThrow('network');
  expect(controller.start).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Run safety-net tests and verify RED**

Run: `pnpm --filter @meeting/web test -- src/meeting/screen-share.test.tsx`

Expected: current code starts P2P before/without persistent SFU and swallows SFU synchronization failures.

- [ ] **Step 5: Implement persistent publication and page handover**

Remove state-driven LiveKit publish/release from `HybridScreenSharePublisher`. In `publish`, clone/capture as currently required, await the fallback publisher first, then start P2P; on failure release both resources and rethrow. In the page, derive P2P candidates from the intersection of LiveKit participants and the signaling roster. On viewer ready, render P2P then unsubscribe SFU. On fallback, subscribe SFU, wait for `ScreenStage`'s `onFirstFrame('livekit')`, switch, then complete P2P cleanup.

- [ ] **Step 6: Add old-client and no-black-frame integration tests**

```ts
it('keeps an unadvertised legacy participant on the LiveKit screen path', async () => {
  renderRoom({ livekitParticipants: [legacyViewer], p2pPeers: [] });
  await startShare();
  expect(livekitPublisher.publish).toHaveBeenCalledOnce();
  expect(p2pController.start).toHaveBeenCalledWith(expect.anything(), expect.anything(), []);
});

it('does not clear the p2p source until the subscribed LiveKit source renders its first frame', async () => {
  requestFallback();
  expect(stage.currentSource()).toBe('p2p');
  emitLiveKitFirstFrame();
  expect(stage.currentSource()).toBe('livekit');
  expect(p2pPc.closed).toBe(true);
});
```

- [ ] **Step 7: Run focused web tests and commit**

Run: `pnpm --filter @meeting/web test -- src/meeting/room.test.tsx src/meeting/screen-share.test.tsx src/components/screen-stage.test.tsx src/pages/meeting-room-page.test.tsx`

```powershell
git add apps/web/src/meeting/room-controller.ts apps/web/src/meeting/room.test.tsx apps/web/src/meeting/screen-share.ts apps/web/src/meeting/screen-share.test.tsx apps/web/src/pages/meeting-room-page.tsx apps/web/src/components/screen-stage.tsx apps/web/src/components/screen-stage.test.tsx
git commit -m "fix(web): retain livekit safety net during p2p sharing"
```

### Task 6: Close P2P rooms on every terminal path and stop automatic telemetry uploads

**Files:**
- Modify: `apps/api/src/p2p/room-registry.ts`
- Modify: `apps/api/src/p2p/room-registry.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/api.test.ts`
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Modify: `apps/web/src/pages/meeting-room-page.test.tsx`
- Modify: `apps/web/src/meeting/p2p-stats.ts`

**Interfaces:**
- Adds `P2pRoomRegistry.closeRoom(slug: string, reason: string): void`, which broadcasts `share-gone`, closes sockets, and deletes the room.
- Adds optional `onMeetingsCleaned(slugs: string[]): void` to `startManagedServer`; `startServer` passes cleaned slugs to the same registry instance used by `buildApp`.
- Removes automatic calls to `P2pStatsCollector.report()` from component cleanup and leave/end handlers; local observations remain local.

- [ ] **Step 1: Add failing registry and background-cleanup tests**

```ts
it('closes every socket and removes the room after notifying peers', () => {
  registry.closeRoom('meeting-a', 'meeting expired');
  expect(socket.messages.at(-1)).toContain('share-gone');
  expect(socket.closed).toBe(true);
  expect(registry.listPeers('meeting-a')).toEqual([]);
});

it('closes p2p rooms returned by scheduled cleanup', async () => {
  meetings.runCleanup.mockResolvedValue(['expired-slug']);
  await startManagedServer({ ...deps, onMeetingsCleaned });
  expect(onMeetingsCleaned).toHaveBeenCalledWith(['expired-slug']);
});
```

- [ ] **Step 2: Run API tests and verify RED**

Run: `pnpm --filter @meeting/api test -- src/p2p/room-registry.test.ts test/api.test.ts`

- [ ] **Step 3: Implement terminal cleanup using the shared registry**

Create one `P2pRoomRegistry` in `startServer`, pass it into `buildApp`, and call `p2p.closeRoom(slug, 'meeting ended')` for every slug returned from startup/interval cleanup. Change explicit end/release routes to call `closeRoom` only when the whole meeting is terminal; share release continues to broadcast without closing the signaling room.

- [ ] **Step 4: Add a failing privacy test**

```ts
it('does not upload p2p statistics on unmount, leave, or terminal meeting', async () => {
  const report = vi.fn();
  const view = renderRoom({ statsCollector: { ...collector, report } });
  await leaveMeeting();
  view.unmount();
  expect(report).not.toHaveBeenCalled();
});
```

Run: `pnpm --filter @meeting/web test -- src/pages/meeting-room-page.test.tsx`

Expected: `report` is called by current cleanup/leave code.

- [ ] **Step 5: Remove automatic report calls, run focused tests, and commit**

Run: `pnpm --filter @meeting/api test -- src/p2p/room-registry.test.ts test/api.test.ts && pnpm --filter @meeting/web test -- src/pages/meeting-room-page.test.tsx src/meeting/p2p-stats.test.tsx`

```powershell
git add apps/api/src/p2p/room-registry.ts apps/api/src/p2p/room-registry.test.ts apps/api/src/server.ts apps/api/test/api.test.ts apps/web/src/pages/meeting-room-page.tsx apps/web/src/pages/meeting-room-page.test.tsx apps/web/src/meeting/p2p-stats.ts
git commit -m "fix(p2p): clean terminal rooms and keep stats local"
```

### Task 7: Align security, deployment, privacy documentation, and lint

**Files:**
- Modify: `docs/03-implementation-specification.md`
- Modify: `docs/04-deployment-and-operations.md`
- Modify: `docs/06-security-and-privacy.md`
- Modify: `docs/07-p2p-screen-share-design.md`
- Modify: `docs/superpowers/specs/2026-08-11-p2p-screen-share-hybrid.md`
- Modify: `scripts/smoke-test.sh`
- Modify: `apps/web/src/meeting/p2p-share-controller.test.tsx`
- Modify: `apps/web/src/meeting/p2p-signaling.test.tsx`

**Interfaces:**
- Documents `P2P_STUN_URLS`, persistent SFU publication, per-viewer unsubscribe, `media-ready`, continuous RTP checks, WebSocket Origin policy, and consent requirement.
- Removes the real public IPv4 and replaces it with a redacted measurement description.
- Smoke test exercises authenticated ICE configuration and rejects cross-site WebSocket Origin.

- [ ] **Step 1: Fix the two known lint errors**

Remove the unused `P2pShareController` import and unused `socket` local without changing test behavior.

- [ ] **Step 2: Update the four normative documents and original P2P spec**

Replace every `/rtc/ice`, one-hour ICE cache, “SFU unpublished after P2P”, and automatic anonymous-report statement with the approved production-hardening behavior. Replace the literal household public IP with “家庭公网 IPv4（已脱敏，湖北移动）”.

- [ ] **Step 3: Update the smoke test behavior**

Use `P2P_STUN_URLS=stun:stun.example.test:3478` in the controlled smoke environment; assert the authenticated ICE response contains that URL and a WebSocket request with `Origin: https://evil.example` receives 403.

- [ ] **Step 4: Run documentation consistency and lint checks**

Run:

```powershell
rg -n "/rtc/ice|P2P_ICE_CACHE_TTL_SECONDS|117\.151\.175\.232|自动上报|鍖垮悕" docs apps packages infra
pnpm lint
```

Expected: `rg` has no obsolete production claims or leaked literal IP; lint exits 0 with no warnings.

- [ ] **Step 5: Commit**

```powershell
git add docs/03-implementation-specification.md docs/04-deployment-and-operations.md docs/06-security-and-privacy.md docs/07-p2p-screen-share-design.md docs/superpowers/specs/2026-08-11-p2p-screen-share-hybrid.md scripts/smoke-test.sh apps/web/src/meeting/p2p-share-controller.test.tsx apps/web/src/meeting/p2p-signaling.test.tsx
git commit -m "docs: align p2p operations and privacy"
```

### Task 8: Full regression, browser verification, and acceptance record

**Files:**
- Create: `apps/web/e2e/p2p-screen-share.spec.ts`
- Modify: `apps/web/e2e/helpers.ts`
- Create: `docs/runbooks/p2p-production-hardening-verification.md`

**Interfaces:**
- Produces repeatable browser cases for direct P2P, legacy SFU, rejected Origin, RTP-stall fallback, and source retention.
- Produces a verification record that distinguishes automated loopback/fake-LiveKit evidence from pending real-network NAT evidence.

- [ ] **Step 1: Add an E2E case that fails before the safety-net implementation**

Create one modern viewer and one viewer with the P2P WebSocket blocked. Start sharing and assert both render the screen; then stall the modern viewer's P2P stats and assert it switches to LiveKit without the screen stage becoming empty.

- [ ] **Step 2: Run Chromium P2P E2E and verify RED, then make only test-fixture wiring changes needed for deterministic media health**

Run: `pnpm --filter @meeting/web exec playwright test e2e/p2p-screen-share.spec.ts --project=chromium`

- [ ] **Step 3: Run the complete quality gate**

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @meeting/web exec playwright test e2e/p2p-screen-share.spec.ts --project=chromium
pnpm --filter @meeting/web exec playwright test e2e/p2p-screen-share.spec.ts --project=edge
```

Expected: every command exits 0; report exact test counts and retain the Vite chunk-size warning as a non-blocking existing build warning if still present.

- [ ] **Step 4: Inspect the final diff and requirement coverage**

Run:

```powershell
git diff --check origin/codex/web-meeting-implementation...HEAD
git status --short
git log --oneline origin/codex/web-meeting-implementation..HEAD
```

Confirm every global constraint has a corresponding passing test or documented production-only NAT acceptance step. Do not claim real-NAT validation unless it was actually run.

- [ ] **Step 5: Write and commit the verification record**

Record command timestamps, exit codes, test counts, browser projects, known chunk warning, and the unexecuted real-network matrix explicitly.

```powershell
git add apps/web/e2e/p2p-screen-share.spec.ts apps/web/e2e/helpers.ts docs/runbooks/p2p-production-hardening-verification.md
git commit -m "test: verify p2p production hardening"
```

## Self-Review

- Spec coverage: ICE support is Task 1; Origin is Task 2; media-ready is Task 3; direct/RTP health and deferred close are Task 4; persistent SFU, legacy clients, subscription handover and error propagation are Task 5; lifecycle and consent are Task 6; normative docs, IP redaction and lint are Task 7; full/browser evidence is Task 8.
- Placeholder scan: the plan contains no deferred implementation placeholders. Real-NAT acceptance is explicitly outside automated proof and must be reported as unexecuted unless actually performed.
- Type consistency: `media-ready`, `handleMediaReady`, `sendMediaReady`, `inspectP2pMediaHealth`, `setRemoteScreenShareSubscribed`, `closeRoom`, and `onMeetingsCleaned` are defined before their later consumers.
- Execution mode: inline execution is authorized by the user's “修复它” request; use `superpowers:executing-plans` and stop at review checkpoints if verification exposes a design conflict.
