# Cloudflare screen recovery

**Goal:** Automatically restore Cloudflare screen sharing and use server coturn while the SFU recovers.

**Design:** Keep a single serialized SFU allocation per owner. Treat disconnected as transient for 2 seconds, failed as immediate. Recreate failed sessions with bounded exponential retry (0.5–10 seconds), preserving capture and stopping on revoked authorization. Request an on-demand coturn peer stream during recovery, retaining it until the replacement SFU stream renders. Never permanently change the viewer's transport preference. No continuously transmitted backup in healthy operation.

**Evidence:** `cloudflare-sfu.ts` immediately reports both disconnected and failed; `use-cloudflare-screen.ts` only retries on a manual revision. The page rejects all peer signaling while an SFU publication exists. Allocation, ICE gathering, connection, and cleanup all have separate bounded waits; backend cleanup intentionally gates replacement to prevent leaked allocations.

**Alternatives:** Retry alone leaves the recovery blackout. An always-on relay reduces failover latency but duplicates normal upload and TURN traffic. On-demand relay matches the requested temporary fallback, with a short unavoidable setup delay.

**Execution:** Implement inline using test-driven-development.

- [x] Pin transient disconnect and persistent failure behavior in session tests.
- [x] Add a cancellable serialized recovery wrapper with capped retries, first-video deadline, stale callback guards, and lifecycle tests.
- [x] Wire viewer and publisher recovery into the room; activate relay on demand with coturn and relay-only ICE; retain relay through SFU replacement and release after rendered video.
- [x] Test viewer-only failure, publisher failure, stop during pending work, late snapshots, normal healthy SFU, and preference preservation.
- [x] Run focused tests, typecheck, lint and production build; review final changes.

**Limits:** Local tests simulate failures; they cannot attribute a particular production disconnect without contemporaneous ICE/network logs. TURN also requires reachable signaling and server connectivity. Server allocation/cleanup safety remains intact.

## Verification

- `pnpm test`: 73 files, 959 tests passed.
- `pnpm typecheck` and `pnpm build`: passed. Vite retains its large-chunk warning.
- ESLint on all 12 changed/new TypeScript files: passed. Global `pnpm lint` encounters 42 existing errors in unrelated untracked `output/` scripts; those were not modified.
- `git diff --check`: passed.
- Independent review findings fixed and rechecked: preserve SFU discovery through signaling disconnect/rejoin; preserve relay-only policy and future preferences during publication withdrawal; retain first-frame listener through React callback changes.
- Terminal authorization failures cancel delayed fallback and automatic retries; initial forbidden publication rejects so capture/grant can be released.
- No deployment or production-network failure injection performed.

Recovery follows [Cloudflare session lifecycle guidance](https://developers.cloudflare.com/realtime/sfu/concepts/negotiation/#retry-and-reconnect): serialize mutations, discard stale responses, and retain late allocations for cleanup rather than blindly duplicating tracks.
