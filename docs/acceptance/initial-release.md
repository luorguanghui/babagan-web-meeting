# Initial release acceptance

## Decision

**Not released.** This repository has local implementation evidence but no
target-server or Cloudflare credentials. The pending target checks below are not
represented as passing production evidence.

| Field | Evidence |
|---|---|
| Candidate branch | `codex/web-meeting-implementation` |
| Candidate SHA | Recorded by the controlled deployment command |
| Target URL | `https://meet.babagan.cloud` |
| Deployment procedure | [deployment record](../runbooks/deployment-record.md) |
| Rollback procedure | [rollback record](../runbooks/rollback-record.md) |

## Local gates

| Gate | Status |
|---|---|
| Unit, integration and browser component tests | Passed locally: `pnpm test`, 18 files / 200 tests, 2026-08-08 |
| Type check, lint and production build | Passed locally: `pnpm typecheck`, `pnpm lint`, `pnpm build`, 2026-08-08 |
| Placeholder and secret scan | Passed locally with the prescribed `rg` command, 2026-08-08 |
| Deployment and rollback script syntax | Passed locally: Git Bash `bash -n` for both scripts, 2026-08-08 |

## Release-blocking target evidence

| Requirement | Evidence required | Status |
|---|---|---|
| Create/join/capacity | API plus Chrome/Edge random-link and password UX evidence | Pending target-server execution |
| Five-way audio | Five microphones, echo observation, supported Windows Chrome/Edge versions | Pending target-server execution |
| Screen share | Standard 1080p30, motion 1080p60, aspect ratio and computer-audio guidance | Pending target-server execution |
| Reconnect/transports | 10-second reconnect, direct UDP, TURN/UDP 443 and RTC/TCP 7881 | Pending target-server execution |
| Two-hour stability | CPU, RAM, restart, disk, 5xx and 200 Mbps threshold report | Pending target-server execution |
| Security | rate/cookie/Origin/XSS/SQL/body/media/revocation checks and scans; no high severity | Pending target-server execution |
| TLS and public exposure | firewall, Cloudflare Full (strict), HTTPS/WSS health and smoke evidence | Pending target-server execution |
| Recovery | backup restore and rollback rehearsals | Pending target-server execution |

Release approval requires linked, dated evidence for every row and every gate
in [the acceptance plan](../05-test-and-acceptance.md). A failed load/media
threshold, high-severity security issue, unsuccessful smoke check, or unverified
rollback blocks publication.
