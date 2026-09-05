# P2P TURN recovery and share-state consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each task uses checkbox steps for tracking.

**Goal:** Keep screen-share state authoritative across LiveKit, SQLite, browsers, and P2P signaling, while making Cloudflare TURN usable and diagnosable on the Alibaba host.

**Architecture:** LiveKit webhook processing will return a post-commit share-release outcome; the HTTP route will broadcast that outcome through the existing P2pRoomRegistry, gated by webhook idempotency and an actual matching database update. Cloudflare TURN will retain the current safe coturn fallback, add redacted error classification, and use only a server-tested CLOUDFLARE_TURN_CONNECT_IPS value when DNS-selected Cloudflare edges are unreachable.

**Tech Stack:** TypeScript, Fastify, livekit-server-sdk, SQLite via better-sqlite3, React/Vite, Vitest, Docker Compose, coturn, Cloudflare Realtime TURN.

**Spec:** docs/superpowers/specs/2026-09-05-p2p-turn-recovery-and-share-state-design.md

## Global Constraints

- meetings.share_identity remains the authorization source for P2P offers.
- A webhook release notice is emitted only after a matching share lock is actually cleared and only once for an idempotently processed webhook.
- Do not expose Cloudflare API tokens, generated TURN credentials, SDP, ICE candidates, or participant data in logs, Git, browser output, or the design record.
- The provider-specific client gate accepts Cloudflare only when the response says turnProvider: cloudflare.
- Do not modify production firewall rules or secrets until a read-only connectivity probe identifies the exact missing network path.
- The LiveKit/SFU fallback remains available throughout the change.

---

### Task 1: Return and broadcast authoritative share-release outcomes

**Files:**
- Modify: apps/api/src/livekit/webhook-handler.ts:25-205
- Modify: apps/api/src/http/routes/livekit-webhook.ts:1-15
- Modify: apps/api/src/app.ts:58-65
- Modify: apps/api/test/livekit.test.ts:158-330
- Modify: apps/api/test/api.test.ts:288-303,410-520
- Modify: apps/api/src/http/routes/ice-servers.test.ts:368-370
- Modify: apps/api/test/local-e2e-server.ts:119-122

**Interfaces:**
- Produce WebhookShareGoneNotice = { slug: string; reason: string } and WebhookHandleResult = { shareGone?: WebhookShareGoneNotice } from apps/api/src/livekit/webhook-handler.ts.
- Change WebhookHandler.handle(rawBody, authorization?) to return Promise<WebhookHandleResult>.
- Change registerLiveKitWebhookRoute(app, webhooks, p2p) to call p2p.broadcastShareGone(result.shareGone.slug, result.shareGone.reason) only after webhooks.handle resolves.

- [ ] **Step 1: Write the failing webhook tests.**

Add one test for a matching track_unpublished event returning one notice and returning an empty object for duplicate delivery. Add one test with share_identity set to participant-2 and an unpublish from participant-1; assert the result is empty and participant-2 still owns the lock. Change the existing matching participant-left test to assert the same share-gone notice.

~~~ts
it('returns one share-gone notice when a matching screen track is unpublished', async () => {
  const meeting = repo.findBySlug('meeting-one');
  if (!meeting) throw new Error('meeting fixture missing');
  repo.trySetShareIdentity(meeting.id, meeting.version, 'participant-1');
  const delivery = await signedWebhook({
    id: 'event-share-gone-notice',
    event: 'track_unpublished',
    room: { name: 'meeting-1' },
    participant: { identity: 'participant-1' },
    track: { source: 'SCREEN_SHARE' }
  });

  await expect(handler.handle(delivery.rawBody, delivery.authorization)).resolves.toEqual({
    shareGone: { slug: 'meeting-1', reason: 'share released' }
  });
  await expect(handler.handle(delivery.rawBody, delivery.authorization)).resolves.toEqual({});
});
~~~

- [ ] **Step 2: Run the focused test and verify the expected red failure.**

Run:

~~~bash
pnpm vitest run apps/api/test/livekit.test.ts
~~~

Expected: the new assertions fail because LiveKitWebhookHandler.handle currently resolves undefined and exposes no post-commit outcome.

- [ ] **Step 3: Implement the minimal outcome plumbing.**

In webhook-handler.ts, add WebhookShareGoneNotice, WebhookHandleResult, and an internal WebhookApplyResult containing mediaAction? and shareGone?. Make applyEvent return an empty result for unrelated events. In participantLeft and trackUnpublished, use the SQL UPDATE changes count to attach a notice only when the current lock matched the event identity. Preserve processed_webhooks idempotency and the existing media-action retry behavior.

In livekit-webhook.ts, accept a P2pRoomRegistry, call the handler, and broadcast only a returned notice. In app.ts, pass the already-created p2p registry. Update every WebhookHandler test stub to return {}.

- [ ] **Step 4: Add the route wiring regression test.**

Inject a P2pRoomRegistry and a capturing webhook stub into the API fixture. Return { shareGone: { slug: 'meeting-1', reason: 'share released' } } from the stub, post a valid raw webhook request, and assert:

~~~ts
expect(response.statusCode).toBe(204);
expect(fixture.p2p.broadcastShareGone).toHaveBeenCalledWith('meeting-1', 'share released');
~~~

Set the stub result to {} in a second request and assert that no broadcast occurs.

- [ ] **Step 5: Run the focused green test set.**

~~~bash
pnpm vitest run apps/api/test/livekit.test.ts apps/api/test/api.test.ts apps/api/src/p2p/room-registry.test.ts
~~~

Expected: all focused tests pass, including duplicate delivery and stale-identity cases.

- [ ] **Step 6: Commit the independently testable API change.**

~~~bash
git add apps/api/src/livekit/webhook-handler.ts apps/api/src/http/routes/livekit-webhook.ts apps/api/src/app.ts apps/api/test/livekit.test.ts apps/api/test/api.test.ts apps/api/src/http/routes/ice-servers.test.ts apps/api/test/local-e2e-server.ts
git commit -m "fix(api): broadcast webhook share release state"
~~~

---

### Task 2: Make Cloudflare TURN fallback failures observable without leaking secrets

**Files:**
- Modify: apps/api/src/services/cloudflare-turn.ts:1-115
- Modify: apps/api/src/http/routes/ice-servers.ts:1-90
- Modify: apps/api/src/services/cloudflare-turn.test.ts:1-40
- Modify: apps/api/src/http/routes/ice-servers.test.ts:110-300

**Interfaces:**
- Produce CloudflareTurnErrorClass = network-timeout | network-unreachable | http-error | invalid-response | unknown.
- Produce describeCloudflareTurnFailure(error): { provider: 'cloudflare'; host: 'rtc.live.cloudflare.com'; errorClass: CloudflareTurnErrorClass }.
- Keep fetchCloudflareTurnIceServers and the ICE response schema unchanged.

- [ ] **Step 1: Write the failing classification tests.**

~~~ts
it.each([
  [Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }), 'network-timeout'],
  [Object.assign(new Error('fetch failed'), { cause: { code: 'ENETUNREACH' } }), 'network-unreachable'],
  [new Error('Cloudflare TURN credentials request failed with 503'), 'http-error'],
  [new Error('Cloudflare TURN response contains no usable ICE servers'), 'invalid-response']
] as const)('classifies an error as %s', (error, expected) => {
  expect(describeCloudflareTurnFailure(error)).toEqual({
    provider: 'cloudflare',
    host: 'rtc.live.cloudflare.com',
    errorClass: expected
  });
});

it('does not include original error text in fallback details', () => {
  expect(describeCloudflareTurnFailure(new Error('Bearer super-secret-token'))).toEqual({
    provider: 'cloudflare',
    host: 'rtc.live.cloudflare.com',
    errorClass: 'unknown'
  });
});
~~~

- [ ] **Step 2: Run the focused test and verify the expected red failure.**

~~~bash
pnpm vitest run apps/api/src/services/cloudflare-turn.test.ts
~~~

Expected: the import or assertions fail because the helper does not exist.

- [ ] **Step 3: Implement redacted classification and route logging.**

Inspect error.cause.code and nested cause.errors[].code for ETIMEDOUT and ENETUNREACH. Classify the existing HTTP-status error as http-error, known response-shape errors as invalid-response, and all other failures as unknown.

In the ice-servers.ts catch block, call:

~~~ts
request.log.warn(
  describeCloudflareTurnFailure(error),
  'Cloudflare TURN credentials unavailable; using coturn fallback'
);
return coturn;
~~~

Do not include error.message, request headers, response bodies, API credentials, or generated ICE credentials in the log metadata.

- [ ] **Step 4: Keep the route fallback contract covered.**

Retain the existing tests asserting that a failed explicit Cloudflare request returns turnProvider: coturn and no Cloudflare credential fields. Add an assertion that availableTurnProviders remains ['coturn', 'cloudflare'] when both credentials are configured, distinguishing configured-but-unavailable from unconfigured.

- [ ] **Step 5: Run the focused green test set.**

~~~bash
pnpm vitest run apps/api/src/services/cloudflare-turn.test.ts apps/api/src/http/routes/ice-servers.test.ts
~~~

- [ ] **Step 6: Commit the independently testable observability change.**

~~~bash
git add apps/api/src/services/cloudflare-turn.ts apps/api/src/http/routes/ice-servers.ts apps/api/src/services/cloudflare-turn.test.ts apps/api/src/http/routes/ice-servers.test.ts
git commit -m "fix(api): expose redacted Cloudflare TURN failures"
~~~

---

### Task 3: Validate and configure the Cloudflare egress path on the target server

**Files:**
- Modify: infra/.env.production.example:22-30
- Modify: docs/04-deployment-and-operations.md in the Cloudflare TURN and update sections
- Modify: docs/runbooks/deployment-record.md in the preflight evidence section
- Protected target file only: /opt/babagan-web-meeting/infra/.env.production

**Interfaces:**
- CLOUDFLARE_TURN_CONNECT_IPS remains a comma-separated list parsed by loadConfig and used by the pinned-HTTPS request with rtc.live.cloudflare.com SNI/Host.
- The target environment is meet.babagan.cloud, rtc.babagan.cloud, and turn.babagan.cloud on 8.162.24.2; no secret values are copied into Git or chat.

- [ ] **Step 1: Document the tested-IP rule.**

Add a comment to infra/.env.production.example explaining that CLOUDFLARE_TURN_CONNECT_IPS may contain only IPs proven reachable from the target host and that TLS SNI/HTTP Host remain rtc.live.cloudflare.com. Add the probe and protected-file backup procedure to docs/04-deployment-and-operations.md.

- [ ] **Step 2: Probe Cloudflare edges from the host and API container.**

Run this on the server without an API token:

~~~bash
getent ahostsv4 rtc.live.cloudflare.com www.cloudflare.com api.cloudflare.com | awk '{print $1}' | sort -u
for ip in $(getent ahostsv4 rtc.live.cloudflare.com www.cloudflare.com api.cloudflare.com | awk '{print $1}' | sort -u); do
  printf '%s ' "$ip"
  timeout 8 curl -4 --resolve "rtc.live.cloudflare.com:443:$ip" \
    --silent --show-error --output /dev/null \
    --write-out 'http=%{http_code} remote=%{remote_ip}\n' \
    https://rtc.live.cloudflare.com/ || true
done
~~~

Repeat the selected-IP check from the API container with a no-credential fetch to https://rtc.live.cloudflare.com/. Accept any HTTP response as transport reachability and reject status 000, timeout, or unreachable results.

- [ ] **Step 3: Update the protected env only when a reachable IP exists.**

Create a mode-600 backup before editing:

~~~bash
sudo cp -p /opt/babagan-web-meeting/infra/.env.production \
  /root/babagan-protected/env.production.before-cloudflare-$(date -u +%Y%m%dT%H%M%SZ)
~~~

Use the measured reachable IP to replace or append exactly one CLOUDFLARE_TURN_CONNECT_IPS= line. If no reachable IP exists, leave the env unchanged and record that the remaining blocker is Alibaba-to-Cloudflare egress; do not guess an IP or rotate credentials.

- [ ] **Step 4: Verify the real credential-generation request without printing secrets.**

After the new API image is running, execute the same POST path from inside the API container using its protected environment, printing only status, top-level keys, and ice-server count. Require a 2xx response with a non-empty iceServers array. A network or non-2xx response blocks Cloudflare activation and triggers restoration of the protected env backup.

- [ ] **Step 5: Commit the public documentation changes.**

~~~bash
git add infra/.env.production.example docs/04-deployment-and-operations.md docs/runbooks/deployment-record.md
git commit -m "docs: document Cloudflare TURN egress validation"
~~~

---

### Task 4: Full regression, fresh-meeting verification, and production deployment

**Files:**
- Verify all modified files from Tasks 1–3
- Preserve target evidence outside Git under /opt/babagan-web-meeting/var/releases/ and /opt/babagan-web-meeting/var/backups/

**Interfaces:**
- The release uses the full SHA returned by git rev-parse HEAD.
- scripts/deploy.sh remains the only production release entry point.
- When Cloudflare credentials are configured, deployment-smoke.sh must pass its explicit SMOKE_REQUESTED_TURN_PROVIDER=cloudflare round.

- [ ] **Step 1: Run the complete local gate after all code changes.**

~~~bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
"C:/Program Files/Git/bin/bash.exe" -lc 'set -e; ./scripts/http-headers.test.sh; ./scripts/deployment-smoke.test.sh; ./scripts/deployment-scripts.test.sh'
git diff --check
~~~

Expected: lint/typecheck/build succeed, Vitest reports zero failures, shell regression checks pass, and no whitespace errors are reported.

- [ ] **Step 2: Push the reviewed branch and synchronize the target checkout.**

~~~bash
git push origin codex/receiver-audio-volume
~~~

On the server, fetch over the verified HTTPS repository URL and checkout the exact local SHA:

~~~bash
sudo git -C /opt/babagan-web-meeting fetch https://github.com/luorguanghui/babagan-web-meeting.git codex/receiver-audio-volume
TARGET_SHA=$(sudo git -C /opt/babagan-web-meeting rev-parse FETCH_HEAD)
sudo git -C /opt/babagan-web-meeting checkout --detach "$TARGET_SHA"
~~~

Confirm the target checkout is clean and var/releases/pending-release.env does not exist before starting the release.

- [ ] **Step 3: Run the protected deployment.**

If MemAvailable is below 1.1 GiB, follow the documented stop-and-drop-caches procedure before deployment. Then run:

~~~bash
RELEASE_SHA=$(sudo git -C /opt/babagan-web-meeting rev-parse HEAD)
cd /opt/babagan-web-meeting
sudo bash scripts/deploy.sh \
  --confirm-deploy "$RELEASE_SHA" \
  --target-ip 8.162.24.2 \
  --smoke-token-file /root/babagan-secrets/smoke-token \
  --network-evidence /root/babagan-protected/network.txt \
  --cloudflare-evidence /root/babagan-protected/cloudflare.txt \
  --allow-public-ssh
~~~

Preserve the DEPLOY SUCCEEDED line, release record, backup path/checksum, service health, default ICE smoke, and explicit Cloudflare smoke output.

- [ ] **Step 4: Verify a newly created meeting instead of the ended stale meeting.**

Create a fresh meeting and join it from two browser sessions. Before starting the share, select Server coturn and verify a P2P viewer reaches TURN relay via coturn. Repeat with Cloudflare TURN and verify the ICE response reports turnProvider: cloudflare and the viewer reaches TURN relay via Cloudflare. Test direct P2P separately and verify SFU remains an explicit fallback.

- [ ] **Step 5: Run final server evidence checks.**

~~~bash
sudo docker compose --env-file infra/.env.production -f infra/docker-compose.yml ps
curl --fail --silent --show-error https://meet.babagan.cloud/health/live
curl --fail --silent --show-error https://meet.babagan.cloud/health/ready
curl --fail --silent --output /dev/null --write-out '%{http_code}\n' https://meet.babagan.cloud/
sudo test ! -e var/releases/pending-release.env
~~~

Verify the current release SHA matches GitHub and the server checkout, the backup sidecar reports OK, and protected release files remain mode 600. Do not print or preserve tokens, credentials, SDP, ICE candidates, or participant data.

- [ ] **Step 6: Review final Git state.**

~~~bash
git status --short
git log -3 --oneline
~~~

Only tracked source/docs changes belong in Git. Server release evidence and protected env backups remain outside Git.
