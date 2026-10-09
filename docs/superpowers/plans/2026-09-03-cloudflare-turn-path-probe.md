# Cloudflare TURN Path Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unrelated Cloudflare HTTPS speed test with an independent Cloudflare TURN path probe, then use that probe to raise the sender transport bitrate cap and to drive bounded, frame-rate-first recovery without ever mutating the fixed quality-profile target.

**Architecture:** A single relay-only probe is owned by the sharer-side `P2pShareController` whenever at least one viewer actually uses Cloudflare TURN. A pure probe-capacity reducer and a pure per-viewer encoding reducer keep measurement, transport-cap control, and UI separate. The browser loopback topology is a hard feasibility gate; if it fails against real Cloudflare credentials, stop this plan and write the separate Pion fallback plan from the approved spec.

**Tech Stack:** TypeScript 5.9, React 19, browser WebRTC (`RTCPeerConnection`, `RTCDataChannel`, `getStats`), Vitest 4, Testing Library, Playwright for the opt-in real-provider gate.

**Spec:** `docs/superpowers/specs/2026-09-03-cloudflare-turn-path-probe-design.md`

## Global Constraints

- `profileTargetBitrateBps` is fixed for the lifetime of one share; dynamic code only changes `transportBitrateCapBps`.
- `availableOutgoingBitrate`, `actualOutgoingBitrate`, a single low probe window, static content, and missing stats must never independently lower the transport cap.
- The probe offered rate must never be derived from the media cap or actual media bitrate.
- One share creates at most one probe regardless of viewer count.
- A weak viewer changes only its own sender parameters.
- Normal output floor is 720p short-side; emergency floor is 540p; browser output below 540p triggers hard resolution protection and must never settle at 270p.
- Cloudflare TURN control does not use the aggregate P2P uplink budget.
- P2P direct, coturn, LiveKit SFU fallback, aspect-ratio preservation, and screen audio behavior must remain unchanged.
- Long-term Cloudflare credentials must never enter the browser, Git, logs, fixtures, or test output.
- Real-provider feasibility uses a mode-600 ephemeral ICE JSON file outside the repository and prints no credential fields.

---

## File Structure

### Create

- `docs/acceptance/cloudflare-turn-loop-probe-2026-09-03.md` — credential-free evidence from the real Edge feasibility gate.
- `apps/web/src/meeting/cloudflare-turn-path-probe.ts` — production relay-only probe topology, DataChannel protocol, pacing, lifecycle, and snapshots.
- `apps/web/src/meeting/cloudflare-turn-path-probe.test.tsx` — fake-WebRTC protocol and lifecycle tests.
- `apps/web/src/meeting/cloudflare-turn-capacity.ts` — pure aggregation of probe windows into stable/stale capacity state.
- `apps/web/src/meeting/cloudflare-turn-capacity.test.tsx` — pure capacity reducer tests.

### Modify

- `apps/web/src/meeting/cloudflare-adaptive-encoding.ts` — rename fixed target vs dynamic cap and consume stable probe snapshots plus sender pressure.
- `apps/web/src/meeting/cloudflare-adaptive-encoding.test.tsx` — death-spiral, raise-cap, bounded-backoff, and sampling-floor tests.
- `apps/web/src/meeting/p2p-media-health.ts` — expose encoder target, discarded sends, RTT, remote loss, and selected relay metadata.
- `apps/web/src/meeting/p2p-media-health.test.tsx` — verify exact stats extraction.
- `apps/web/src/meeting/p2p-share-controller.ts` — own one probe, publish snapshots, and apply per-viewer caps/scales.
- `apps/web/src/meeting/p2p-share-controller.test.tsx` — lifecycle, isolation, and sender-parameter integration.
- `apps/web/src/pages/meeting-room-page.tsx` — remove page-owned HTTPS probing and subscribe to controller probe state.
- `apps/web/src/meeting/screen-share.test.tsx` — room integration and copy tests.
- `apps/web/src/meeting/webrtc-stats.ts` — keep RTC estimate distinct from encoder target, media cap, and actual bitrate.
- `apps/web/src/meeting/webrtc-stats.test.tsx` — stats distinction tests.
- `apps/web/src/components/webrtc-stats-panel.tsx` — detailed probe/cap/target diagnostics.
- `apps/web/src/i18n/i18n.tsx` — honest TURN path probe labels.
- `apps/web/src/styles.css` — reuse the compact badge for ready/stale/error states.
- `docs/02-technical-architecture.md` — document the selected probe topology and control separation.
- `docs/05-test-and-acceptance.md` — add acceptance cases for probe isolation, recovery, and floors.

### Delete after replacement

- `apps/web/src/meeting/cloudflare-uplink-probe.ts`
- `apps/web/src/meeting/cloudflare-uplink-probe.test.tsx`

---

### Task 1: Real Cloudflare Browser Loopback Feasibility Gate

**Files:**
- Create: `docs/acceptance/cloudflare-turn-loop-probe-2026-09-03.md`
- Reference: `apps/web/src/meeting/p2p-ice.ts`
- Reference: `docs/superpowers/specs/2026-09-03-cloudflare-turn-path-probe-design.md`

**Interfaces:**
- Consumes: an already authenticated Edge meeting tab. The in-page script calls the existing participant-authenticated `GET /api/v1/meetings/:slug/ice-servers?turnProvider=cloudflare` endpoint and never returns the ICE configuration outside page scope.
- Produces: credential-free JSON `{ selectedRelay, protocol, windows, medianBps, dispersion }` plus a sanitized acceptance report.
- Gate: Tasks 2–9 execute only if the real-provider probe passes all criteria three times.

- [x] **Step 1**: Prepare the authenticated Edge gate**

Ask the operator to open a disposable authenticated meeting in Edge and select Cloudflare TURN. Use the Browser CDP capability on that exact tab. Enable `Runtime` and `Network`, then execute one in-page async expression. Inside the expression, fetch the Cloudflare ICE configuration with `credentials: 'include'`, keep it in a local variable, and immediately construct the two peer connections. Never return or log the response body.

The in-page browser code must include:

```js
const response = await fetch(
  `/api/v1/meetings/${encodeURIComponent(slug)}/ice-servers?turnProvider=cloudflare`,
  { credentials: 'include' }
);
if (!response.ok) throw new Error(`ICE request failed: ${response.status}`);
const { iceServers, turnProvider } = await response.json();
if (turnProvider !== 'cloudflare') throw new Error('Cloudflare request fell back');
const left = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
const right = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
const data = left.createDataChannel('probe-data', { ordered: false, maxRetransmits: 0 });
const control = left.createDataChannel('probe-control', { ordered: true });
const leftPending = [];
const rightPending = [];
left.onicecandidate = ({ candidate }) => {
  if (!candidate) return;
  if (right.remoteDescription) void right.addIceCandidate(candidate);
  else leftPending.push(candidate);
};
right.onicecandidate = ({ candidate }) => {
  if (!candidate) return;
  if (left.remoteDescription) void left.addIceCandidate(candidate);
  else rightPending.push(candidate);
};
const offer = await left.createOffer();
await left.setLocalDescription(offer);
await right.setRemoteDescription(offer);
for (const candidate of leftPending.splice(0)) await right.addIceCandidate(candidate);
const answer = await right.createAnswer();
await right.setLocalDescription(answer);
await left.setRemoteDescription(answer);
for (const candidate of rightPending.splice(0)) await left.addIceCandidate(candidate);
```

Do not wait for `iceGatheringState === 'complete'`: Cloudflare publishes multiple UDP/TCP/TLS URLs and unreachable alternates may keep gathering open after usable relay candidates exist. The right peer must count 16 KiB data messages and return one reliable cumulative result per window. The left peer must pace writes using `bufferedAmountLowThreshold`, run 2/4/8/16 Mbps windows, and inspect both selected candidate pairs through `transport.selectedCandidatePairId`. Fail unless both selected local candidates are `relay` and their `url` includes `turn.cloudflare.com`. Close both peer connections in `finally`.

- [x] **Step 2**: Add explicit result redaction inside the CDP expression**

Before returning from page scope, serialize the result and reject it if it contains `username`, `credential`, `iceServers`, `password`, `cookie`, or `token`. Return only:

```json
{"selectedRelay":true,"protocol":"udp","windows":[{"offeredBps":2000000,"confirmedBps":1900000,"lossRatio":0}],"medianBps":1900000,"dispersion":0.04}
```

- [x] **Step 3**: Run the gate against the real provider**

Run the CDP expression in the authenticated Edge tab. Expected:

- two selected Cloudflare relay candidates;
- both DataChannels open;
- four confirmed windows;
- returned object contains no credential or participant fields;
- CDP Network events show TURN/WebRTC activity but the saved report contains no addresses or credentials.

- [x] **Step 4**: Repeat three times and enforce the gate**

Expected across three runs:

- every run opens both DataChannels;
- every run confirms 2/4/8/16 Mbps windows;
- median dispersion is at most 25%;
- every process exits after closing both peer connections;
- Cloudflare TURN analytics or browser stats show allocations disappear after the test.

- [x] **Step 5**: Choose the branch**

If any hard criterion fails, write only the failed criterion and sanitized timings to `docs/acceptance/cloudflare-turn-loop-probe-2026-09-03.md`, commit that report with `test(web): record unsupported Cloudflare TURN loopback`, stop this plan, and write `docs/superpowers/plans/2026-09-03-cloudflare-turn-pion-probe.md` from spec section 4.2. Do not continue with a partly working loopback implementation.

If all criteria pass, write the three sanitized results, median, dispersion, cleanup evidence, Edge version, and timestamp to the same acceptance report. Commit:

```bash
git add docs/acceptance/cloudflare-turn-loop-probe-2026-09-03.md
git commit -m "test(web): validate Cloudflare TURN loopback probing"
```

---

### Task 2: Pure TURN Capacity Reducer

**Files:**
- Create: `apps/web/src/meeting/cloudflare-turn-capacity.ts`
- Create: `apps/web/src/meeting/cloudflare-turn-capacity.test.tsx`

**Interfaces:**
- Produces:

```ts
export type TurnPathProbeStatus = 'idle' | 'negotiating' | 'probing' | 'ready' | 'stale' | 'unsupported' | 'error';

export interface TurnProbeWindow {
  offeredBps: number;
  confirmedBytes: number;
  durationMs: number;
  lossRatio: number;
  roundTripTimeMs?: number;
  sampledAt: number;
}

export interface TurnPathProbeSnapshot {
  status: TurnPathProbeStatus;
  measuredCapacityBps?: number;
  stableCapacityBps?: number;
  probeTargetBps: number;
  roundTripTimeMs?: number;
  lossRatio?: number;
  selectedProtocol?: string;
  sampledAt?: number;
}

export interface TurnProbeCapacityState {
  snapshot: TurnPathProbeSnapshot;
  recentValidCapacitiesBps: readonly number[];
  staleUntil?: number;
}

export function reduceTurnProbeWindow(
  previous: TurnProbeCapacityState,
  window: TurnProbeWindow
): TurnProbeCapacityState;

export function markTurnProbeFailure(
  previous: TurnProbeCapacityState,
  now: number
): TurnProbeCapacityState;
```

- [x] **Step 1: Write failing reducer tests**

Cover exact cases:

```ts
it('uses confirmed bytes instead of offered bytes');
it('requires three valid windows before publishing stable capacity');
it('uses the median of the latest three valid capacities');
it('does not replace stable capacity with one low window');
it('marks a recent result stale for 60 seconds after failure');
it('drops expired stable capacity without reporting zero');
it('advances the independent probe ladder even when media is capped low');
```

- [x] **Step 2: Run tests to verify RED**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/meeting/cloudflare-turn-capacity.test.tsx
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the reducer**

Use `confirmedBytes * 8_000 / durationMs`, reject non-finite/zero duration, loss outside 0–1, or timestamps that move backward. Store only the latest three valid capacities in `recentValidCapacitiesBps` and compute their median into the public snapshot. Keep stable capacity for 60 seconds after a failure; never synthesize `0`.

The probe ladder is exactly `[2, 4, 8, 16, 32, 50] * 1_000_000`. Advance only when confirmed throughput reaches at least 85% of offered rate, loss is below 2%, and queued bytes drained by window end.

- [x] **Step 4: Run tests to verify GREEN**

Run the same command. Expected: all capacity tests PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/meeting/cloudflare-turn-capacity.ts apps/web/src/meeting/cloudflare-turn-capacity.test.tsx
git commit -m "feat(web): add TURN probe capacity reducer"
```

---

### Task 3: Production Browser TURN Path Probe

**Files:**
- Create: `apps/web/src/meeting/cloudflare-turn-path-probe.ts`
- Create: `apps/web/src/meeting/cloudflare-turn-path-probe.test.tsx`
- Consume: `apps/web/src/meeting/cloudflare-turn-capacity.ts`

**Interfaces:**
- Produces:

```ts
export interface CloudflareTurnPathProbe {
  start(iceServers: RTCIceServer[]): Promise<void>;
  requestVerification(): void;
  getSnapshot(): TurnPathProbeSnapshot;
  subscribe(listener: (snapshot: TurnPathProbeSnapshot) => void): () => void;
  stop(): Promise<void>;
}

export interface CloudflareTurnPathProbeDependencies {
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  isDocumentVisible?: () => boolean;
  randomBytes?: (size: number) => Uint8Array;
}

export function createCloudflareTurnPathProbe(
  dependencies?: CloudflareTurnPathProbeDependencies
): CloudflareTurnPathProbe;
```

- [x] **Step 1: Write failing protocol/lifecycle tests**

Use fake peer connections and fake DataChannels. Cover:

```ts
it('forces relay policy on both peer connections');
it('rejects a selected host or non-Cloudflare candidate');
it('opens unreliable data and reliable control channels');
it('paces 16 KiB chunks using bufferedAmountLowThreshold');
it('publishes confirmed rather than queued throughput');
it('runs only one verification window at a time');
it('invalidates a window when the document is hidden');
it('stops both peers, channels, listeners, and timers idempotently');
```

- [x] **Step 2: Run tests to verify RED**

```bash
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/meeting/cloudflare-turn-path-probe.test.tsx
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement negotiation and relay validation**

Create both PCs with `{ iceServers, iceTransportPolicy: 'relay' }`, exchange SDP/ICE locally, wait at most 8 seconds for both channels, then call `getStats()` on both PCs. Follow `transport.selectedCandidatePairId` to local/remote candidates. Require `candidateType === 'relay'` and either `url` contains `turn.cloudflare.com` or the supplied ICE configuration contains only Cloudflare TURN URLs.

- [x] **Step 4: Implement the two-channel window protocol**

Use these control messages:

```ts
type ProbeControlMessage =
  | { type: 'start'; windowId: number; offeredBps: number; durationMs: number }
  | { type: 'result'; windowId: number; confirmedBytes: number; receivedMessages: number; highestSequence: number };
```

Send binary frames with a 12-byte header (`windowId`, `sequence`, `payloadLength`) and random payload. Stop writing when the deadline is reached, wait for the reliable result, compute loss, and feed the pure reducer.

- [x] **Step 5: Implement scheduling and failure states**

Run startup ladder windows immediately; run a 500ms recovery window every 10 seconds. `requestVerification()` schedules two 500ms windows but coalesces concurrent requests. On transient failure publish `stale`/`error` and retry at 5s, 15s, 30s, then 30s. Hidden documents do not run active windows.

- [x] **Step 6: Run tests to verify GREEN**

Run the targeted path-probe and capacity tests. Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/web/src/meeting/cloudflare-turn-path-probe.ts apps/web/src/meeting/cloudflare-turn-path-probe.test.tsx
git commit -m "feat(web): probe the Cloudflare TURN path"
```

---

### Task 4: Separate Fixed Quality Target from Dynamic Transport Cap

**Files:**
- Modify: `apps/web/src/meeting/cloudflare-adaptive-encoding.ts`
- Modify: `apps/web/src/meeting/cloudflare-adaptive-encoding.test.tsx`

**Interfaces:**
- Replace the existing state with:

```ts
export interface CloudflareEncodingState {
  profileTargetBitrateBps: number;
  transportBitrateCapBps: number;
  scaleResolutionDownBy: number;
  emergencyResolution: boolean;
  bandwidthPressureSamples: number;
  healthySamples: number;
  lastStableBitrateBps?: number;
}

export interface CloudflareEncodingMeasurement {
  turnProbe: TurnPathProbeSnapshot;
  encoderTargetBitrateBps?: number;
  actualOutgoingBitrateBps?: number;
  availableOutgoingBitrateBps?: number;
  qualityLimitationReason?: string;
  framesPerSecond?: number;
  targetFrameRate: number;
  packetLossRatio?: number;
  roundTripTimeMs?: number;
  packetsDiscardedOnSendDelta?: number;
}
```

- [x] **Step 1: Replace tests with fixed-target semantics**

Write failing tests proving:

```ts
it('never mutates the profile target');
it('raises only the transport cap when probe capacity is high');
it('treats actual outgoing bitrate as read-only evidence, never as a requested bitrate');
it('ignores low RTC estimate, low actual bitrate, static fps, and one low probe');
it('requires two low probe windows plus three pressure samples to back off');
it('backs off between 5 and 20 percent and never increases in the down branch');
it('keeps probe recovery independent from the transport cap');
it('changes scale by at most 10 percent down and 5 percent up');
it('uses 720p normal and 540p emergency short-side floors');
it('activates hard resolution protection below 540p');
```

- [x] **Step 2: Run tests to verify RED**

```bash
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/meeting/cloudflare-adaptive-encoding.test.tsx
```

Expected: failures against the old dynamic-target state.

- [x] **Step 3: Implement cap increase**

When two healthy media samples satisfy `stableCapacityBps >= transportBitrateCapBps * 1.15`, compute:

```ts
const newTransportCap = Math.min(
  currentTransportCap * 1.15,
  stableCapacityBps * 0.90,
  50_000_000
);
```

Return the original `profileTargetBitrateBps` unchanged.

- [x] **Step 4: Implement bounded cap decrease**

Only enter the down branch after two independently low probe windows and three media-pressure samples. Compute:

```ts
const recentFloor = state.lastStableBitrateBps ?? 1_000_000;
const newTransportCap = Math.max(
  state.transportBitrateCapBps * 0.80,
  Math.min(state.transportBitrateCapBps * 0.95, recentFloor * 0.90),
  1_000_000
);
```

If the current cap is already 1 Mbps, hold it at the floor and do not enter the down branch. Otherwise assert in code that `newTransportCap < state.transportBitrateCapBps`. Severe pressure may execute one immediate 20% step.

- [x] **Step 5: Implement absolute sampling scale and floors**

Compute:

```ts
const effectiveBudget = Math.min(state.profileTargetBitrateBps, newTransportCap);
const idealScale = Math.max(1, Math.sqrt(state.profileTargetBitrateBps / effectiveBudget));
```

Clamp the scale so the source short-side remains at least 720px normally or 540px in emergency mode. Slew-limit increasing scale to 10% and recovery to 5% after five healthy samples. If outbound frame size falls below 540p, set hard-resolution protection.

- [x] **Step 6: Run tests to verify GREEN**

Run the adaptive tests. Expected: all PASS.

- [x] **Step 7: Commit**

```bash
git add apps/web/src/meeting/cloudflare-adaptive-encoding.ts apps/web/src/meeting/cloudflare-adaptive-encoding.test.tsx
git commit -m "fix(web): separate TURN transport cap from quality target"
```

---

### Task 5: Extend Sender Pressure Statistics

**Files:**
- Modify: `apps/web/src/meeting/p2p-media-health.ts`
- Modify: `apps/web/src/meeting/p2p-media-health.test.tsx`
- Modify: `apps/web/src/meeting/webrtc-stats.ts`
- Modify: `apps/web/src/meeting/webrtc-stats.test.tsx`

**Interfaces:**
- Extend `SenderVideoStats` with:

```ts
encoderTargetBitrateBps?: number;
packetsDiscardedOnSend?: number;
roundTripTimeMs?: number;
remotePacketsLost?: number;
remotePacketsReceived?: number;
selectedLocalCandidateType?: string;
selectedLocalCandidateUrl?: string;
selectedRelayProtocol?: string;
```

- [x] **Step 1: Write failing stats extraction tests**

Build one `RTCStatsReport` containing outbound RTP, remote inbound RTP, transport, candidate pair, and relay candidate. Assert exact extraction of encoder `targetBitrate`, candidate-pair `packetsDiscardedOnSend`, RTT seconds converted to milliseconds, remote loss counters, and relay URL/protocol.

- [x] **Step 2: Run tests to verify RED**

```bash
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/meeting/p2p-media-health.test.tsx apps/web/src/meeting/webrtc-stats.test.tsx
```

Expected: missing-field assertions fail.

- [x] **Step 3: Implement extraction without defaulting missing data to zero**

Follow `transport.selectedCandidatePairId`, then `localCandidateId`. Find remote inbound RTP for the local outbound stream through `remoteId` when present. Convert RTT to ms. Leave missing fields `undefined` so missing stats cannot look like zero congestion.

- [x] **Step 4: Run tests to verify GREEN**

Run the same targeted tests. Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/meeting/p2p-media-health.ts apps/web/src/meeting/p2p-media-health.test.tsx apps/web/src/meeting/webrtc-stats.ts apps/web/src/meeting/webrtc-stats.test.tsx
git commit -m "feat(web): collect TURN sender pressure stats"
```

---

### Task 6: Own One Probe in `P2pShareController` Observation Mode

**Files:**
- Modify: `apps/web/src/meeting/p2p-share-controller.ts`
- Modify: `apps/web/src/meeting/p2p-share-controller.test.tsx`

**Interfaces:**
- Add to `P2pShareController`:

```ts
getTurnPathProbeSnapshot?(): TurnPathProbeSnapshot;
subscribeTurnPathProbe?(listener: (snapshot: TurnPathProbeSnapshot) => void): () => void;
```

- Add dependency:

```ts
createTurnPathProbe?: () => CloudflareTurnPathProbe;
cloudflareTurnControlMode?: 'observe' | 'control';
```

- Remove `setCloudflareUplinkEstimate` and `cloudflareUplinkEstimateBps`.

- [x] **Step 1: Write failing lifecycle tests**

Cover:

```ts
it('does not start a probe for negotiating, direct, coturn, or SFU sessions');
it('starts one probe when the first viewer becomes Cloudflare turn');
it('does not create another probe for additional Cloudflare viewers');
it('keeps the probe while at least one Cloudflare viewer remains');
it('stops the probe after the final Cloudflare viewer leaves');
it('rebuilds the probe after Cloudflare credential refresh');
it('publishes immutable probe snapshots without changing sender parameters in observation mode');
```

- [x] **Step 2: Run tests to verify RED**

```bash
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/meeting/p2p-share-controller.test.tsx
```

Expected: failures because the controller has no probe lifecycle.

- [x] **Step 3: Implement lifecycle helpers**

Add private `reconcileTurnPathProbe()` called after state/provider transitions, viewer closure, retry, credential refresh, and stop. It starts only when `some(session.state === 'turn' && session.turnProvider === 'cloudflare')`. It reuses the controller's current Cloudflare ICE servers and owns exactly one unsubscribe handle.

- [x] **Step 4: Keep observation mode non-mutating**

Feed probe snapshots to listeners but do not pass them into
`updateCloudflareEncoding` when `cloudflareTurnControlMode` is omitted or
`'observe'`. Tests may construct the controller with `'control'` starting
in Task 7. The production constructor was subsequently switched to `control`
by explicit operator direction on 2026-09-05.

- [x] **Step 5: Run tests to verify GREEN**

Run controller, path-probe, and existing screen-share tests. Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/web/src/meeting/p2p-share-controller.ts apps/web/src/meeting/p2p-share-controller.test.tsx
git commit -m "feat(web): observe one Cloudflare TURN path probe per share"
```

---

### Task 7: Enable Per-Viewer Transport-Cap Control

**Files:**
- Modify: `apps/web/src/meeting/p2p-share-controller.ts`
- Modify: `apps/web/src/meeting/p2p-share-controller.test.tsx`
- Consume: `apps/web/src/meeting/cloudflare-adaptive-encoding.ts`

**Interfaces:**
- `applySenderParameters` writes `state.transportBitrateCapBps` to `encodings[0].maxBitrate`.
- `profileTargetBitrateBps` is initialized from the immutable share option and never overwritten by rebalance/adaptation.

- [x] **Step 1: Write failing integration tests**

Cover:

```ts
it('raises maxBitrate without changing the profile target when probe capacity is high');
it('does not lower maxBitrate for one low probe or one low RTC estimate');
it('backs off only the pressured viewer after corroborated low probe windows');
it('does not include Cloudflare viewers in the aggregate uplink budget');
it('requests probe verification when sender pressure begins');
it('applies continuous scale and 540p hard protection');
```

- [x] **Step 2: Run tests to verify RED**

Run the controller test file. Expected: integration assertions fail while observation mode is active.

- [x] **Step 3: Connect probe and sender measurements**

For each Cloudflare TURN session, compute deltas for bytes, discarded packets, remote loss, and timestamps. Call `updateCloudflareEncoding` with the shared probe snapshot and that session's stats. Store state on the session; never store per-viewer pressure globally.

- [x] **Step 4: Apply sender parameters serially**

Use the existing `senderParameterTail`. Apply:

```ts
encodings: [{
  maxBitrate: state.transportBitrateCapBps,
  maxFramerate: options.frameRate,
  scaleResolutionDownBy: state.scaleResolutionDownBy
}],
degradationPreference: hardResolutionProtection ? 'maintain-resolution' : 'maintain-framerate'
```

- [x] **Step 5: Run tests to verify GREEN**

Run controller, adaptive, media-health, and screen-share tests. Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/web/src/meeting/p2p-share-controller.ts apps/web/src/meeting/p2p-share-controller.test.tsx
git commit -m "feat(web): adapt Cloudflare TURN transport caps per viewer"
```

---

### Task 8: Replace HTTPS Probe UI and Diagnostics

**Files:**
- Delete: `apps/web/src/meeting/cloudflare-uplink-probe.ts`
- Delete: `apps/web/src/meeting/cloudflare-uplink-probe.test.tsx`
- Modify: `apps/web/src/pages/meeting-room-page.tsx`
- Modify: `apps/web/src/meeting/screen-share.test.tsx`
- Modify: `apps/web/src/components/webrtc-stats-panel.tsx`
- Modify: `apps/web/src/i18n/i18n.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Page consumes only `getTurnPathProbeSnapshot` / `subscribeTurnPathProbe`.
- Main badge copy:

```text
Cloudflare TURN 路径探测：12.4 Mbps
Cloudflare TURN 路径探测：重测中（上次 12.4 Mbps）
Cloudflare TURN 路径探测暂不可用（不影响 TURN 连接）
```

- [x] **Step 1: Write failing page tests**

Assert ready, stale, and error copy. Assert no `fetch` call targets `speed.cloudflare.com`. Assert remote viewers and non-Cloudflare paths do not show the badge.

- [x] **Step 2: Run tests to verify RED**

```bash
pnpm exec vitest run --config vitest.config.ts --project web apps/web/src/meeting/screen-share.test.tsx
```

Expected: old page-owned probe and old copy fail assertions.

- [x] **Step 3: Remove page-owned probing**

Delete the `useEffect` that calls `measureCloudflareUplink`, remove its prop/test seam, and delete the HTTPS module/tests. Subscribe to controller snapshots while the local user is sharing.

- [x] **Step 4: Add distinct detailed diagnostics**

Render separate rows for fixed profile target, dynamic transport cap, encoder target, actual bitrate, RTC estimate, probe capacity, scale, selected provider, and relay protocol. Never label RTC estimate or HTTP data as TURN capacity.

- [x] **Step 5: Run tests to verify GREEN**

Run screen-share, stats-panel, and i18n tests. Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/web/src/pages/meeting-room-page.tsx apps/web/src/meeting/screen-share.test.tsx apps/web/src/components/webrtc-stats-panel.tsx apps/web/src/i18n/i18n.tsx apps/web/src/styles.css
git add -u apps/web/src/meeting
git commit -m "feat(web): show verified Cloudflare TURN path capacity"
```

---

### Task 9: Acceptance Coverage, Documentation, and Rollout Gate

**Files:**
- Modify: `docs/02-technical-architecture.md`
- Modify: `docs/05-test-and-acceptance.md`
- Modify: relevant tests from Tasks 2–8 only if an uncovered approved requirement is found.

**Interfaces:**
- Produces a verified observation-mode release first, followed by a control-mode release only after manual acceptance.

- [x] **Step 1: Add acceptance cases**

Document exact cases:

- probe uses relay-only Cloudflare candidates;
- one probe per share;
- no `speed.cloudflare.com` requests;
- fixed profile target never changes;
- high probe raises only transport cap;
- low RTC/actual values alone do not lower cap;
- corroborated congestion lowers one viewer only;
- 720p normal, 540p emergency, never 270p;
- all resources close on stop.

- [x] **Step 2: Run the complete test suite**

```bash
pnpm test
```

Expected: all projects PASS.

- [x] **Step 3: Run static and production checks**

```bash
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Expected: all exit 0; only the existing Vite chunk-size warning is allowed.

- [ ] **Step 4: Run real Edge/Chrome observation acceptance**

Use a real Cloudflare TURN share and record, without credentials:

- selected provider/protocol;
- probe status and stable capacity;
- fixed profile target;
- dynamic cap in observation mode;
- actual bitrate, FPS, resolution, scale;
- probe resource cleanup after stopping.

Expected: probe results are stable enough to meet the spec, no persistent FPS drop during 500ms windows, and no 270p output.

- [x] **Step 5: Enable control by explicit operator override**

The 2026-09-05 operator instruction explicitly overrides the pending manual
observation gate. Change the production controller construction in
`meeting-room-page.tsx` from `cloudflareTurnControlMode: 'observe'` to
`cloudflareTurnControlMode: 'control'`. Keep the dependency injectable so
tests cover both modes. This task does not claim the real observation passed
and does not deploy; failed live validation must revert the switch to
`observe`.

- [x] **Step 6: Update architecture and acceptance docs**

Describe the final selected topology, fixed-target/dynamic-cap terminology, state machine gates, UI labels, and rollback behavior. If Task 1 failed, this step belongs to the separate Pion plan instead.

- [ ] **Step 7: Commit documentation and control-mode gate**

```bash
git add docs/02-technical-architecture.md docs/05-test-and-acceptance.md apps/web/src/pages/meeting-room-page.tsx apps/web/src/meeting/screen-share.test.tsx
git commit -m "feat(web): enable verified Cloudflare TURN control"
```

- [ ] **Step 8: Request code review before push/deploy**

Review the full branch diff against `docs/superpowers/specs/2026-09-03-cloudflare-turn-path-probe-design.md`. Fix all Critical and Important findings, rerun Steps 2–4, then request explicit user direction before pushing or deploying.

---

## Plan Completion Criteria

- Task 1 real-provider gate passed three times, or this plan stopped cleanly and the Pion fallback plan was written.
- Pure reducer tests prove the media cap cannot self-reinforce the probe downward.
- Fixed profile target and dynamic transport cap are distinct in types, logic, stats, and UI.
- One weak viewer cannot change another viewer's sender.
- HTTPS speed probing is deleted from production.
- Full tests, typecheck, lint, build, diff check, real browser observation, and code review all pass.
- No push or deployment occurs without a later explicit user request.
