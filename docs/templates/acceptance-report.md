# Meeting Acceptance Report

## Release identity

| Field | Value |
|---|---|
| Build Git SHA | |
| Deployment timestamp (UTC) | |
| Environment / target URL | |
| Operator | |

## Test environment

| Field | Value |
|---|---|
| Server specification (CPU, RAM, disk, OS) | |
| Public network paths (HTTPS, WSS, UDP direct, TURN/UDP 443, RTC/TCP 7881) | |
| Chrome version / Windows version | |
| Edge version / Windows version | |
| Test admin credential source (do not record the secret) | |

## Automated and manual evidence

| Check | Command / evidence path | Result | UTC timestamp |
|---|---|---|---|
| Unit, integration, typecheck, lint and build | | | |
| Chrome E2E | | | |
| Edge E2E | | | |
| HTTPS/WSS/health/port smoke test | | | |
| Five-way microphone acceptance | | | |
| Standard 1080p30 screen share | | | |
| Motion 1080p60 screen share | | | |
| System/tab audio guidance | | | |
| Reconnect within 10 seconds | | | |
| Direct UDP, TURN/UDP and RTC/TCP paths | | | |

## WebRTC statistics

| Field | Value / evidence file |
|---|---|
| RTT and jitter | |
| Inbound packet loss | |
| Outbound packet loss | |
| Available outgoing bitrate | |
| Concealed audio samples / quality observations | |

## Two-hour load and stability evidence

| Field | Value / evidence file |
|---|---|
| Scenario (five microphones, one 1080p60 screen, four subscribers) | |
| CPU sustained / peak | |
| RSS sustained / peak | |
| First and last 30-minute memory averages | |
| Container restarts / OOM events | |
| Outbound bandwidth / packet loss | |
| API 5xx count | |
| Result against release thresholds | |

## Failure and recovery evidence

| Field | Value / evidence path |
|---|---|
| Failed checks, traces and correlation IDs (no secrets or media) | |
| SQLite backup checksum | |
| Restore rehearsal result | |
| Rollback rehearsal result | |
| Rollback result / final health and smoke result | |

## Approval

| Role | Name | Decision | Date |
|---|---|---|---|
| Technical approver | | Approved / rejected | |
| Service owner | | Approved / rejected | |
