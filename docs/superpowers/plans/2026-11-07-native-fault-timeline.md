# Native fault timeline implementation plan

Goal: manually export one bounded native capture attempt with helper and browser evidence.
Architecture: allowlisted contracts ring, helper session diagnostics endpoint, browser attempt recorder and export button. Existing capture protocol keeps optional diagnostic IDs backward compatible.
Tech stack: TypeScript, Node 24, React, existing Vitest/jsdom/loopback fixtures.
Spec: ../specs/2026-11-07-native-fault-timeline-design.md
Constraints: local changes only; no raw media, stderr, arbitrary errors, addresses or capabilities; no new dependencies or recovery-policy expansion.

- [x] 1. Contracts + helper: write failing privacy/retention/process-exit/recovery/endpoint tests; run; implement sanitizer/ring and events, bounded authenticated export; run native/contracts tests.
- [x] 2. Browser: write failing permission/stop/export tests; run; instrument capture and sender transport, add sharing-settings export; run targeted browser tests.
- [x] 3. Validate: types, affected lint/build, full existing test suite; independent review; record results, fault taxonomy and Windows verification gaps in runbook/acceptance note.

Review focus: callbacks must not break capture; stop/revocation never retries; helper data cannot be misattributed across sessions; old helper/offline export remains usable; arbitrary strings and malformed export responses never escape the whitelist.

Execution: user authorized design and local implementation in the request; continue locally, approval reserved for GitHub PR or deployment. Fresh isolated clone and local branch used. Do not modify production or push.

Execution ledger: contracts/helper and browser tests were written before implementation; initial missing-module/absent-event/unsupported-control assertions failed, then passed. Independent review's pre-format correlation finding reproduced before fix; bounded negotiation and real HTTP regressions now pass. All requested local work complete with the documented environment-specific API validation blocker; no push, PR or deployment.

Rulings: capability probing is required before capture to retain startup failures; otherwise response-only ID correlation is insufficient. Probe is capped at750ms and abortable, old helpers receive the original start control. Page lifecycle events bind actual native tracks. Keep current recovery decisions and EOF behavior.
