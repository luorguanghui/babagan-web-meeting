# Production rollback record

This file describes guarded recovery. It is not evidence that a rollback was executed. Do not roll back during an active meeting. Do not use git reset --hard, delete images, or delete backups as a recovery shortcut.

## Before any rollback

Confirm all of these first:

- The target is the direct predecessor named by the current release record, or the candidate SHA named by a bootstrap-pending record.
- The confirmation argument repeats exactly the same full 40-character lowercase SHA.
- The production env file is mode 600 and Compose configuration validates.
- The database backup and checksum sidecar exist and match the recorded checksum.
- Every predecessor image tag resolves to the immutable image ID recorded in the release/pending record.
- The smoke token file is non-empty, mode 600, and not expired. Generate a fresh token from the current API image before rollback if necessary.
- There is no active meeting or planned destructive migration window.

A stale smoke-token file can make the core-only RTC check fail even when LiveKit is healthy. The normal deployment smoke creates a temporary meeting and signs a fresh Token, but rollback consumes the supplied file directly.

## Roll back a committed release

The current release record must name the requested SHA as its direct predecessor:

~~~bash
cd /opt/babagan-meeting
TARGET_SHA='<current-release.env 中的 PREVIOUS_RELEASE_SHA>'
sudo bash scripts/rollback.sh \
  --target-release-sha "$TARGET_SHA" \
  --confirm-rollback "$TARGET_SHA" \
  --smoke-token-file /root/babagan-secrets/smoke-token
~~~

The script:

1. Validates the current release record, direct-predecessor relationship, image IDs, env mode and smoke-token mode.
2. Creates an additional backup of the live database.
3. Verifies and restores the recorded pre-deploy SQLite backup into a new file.
4. Stops the API, swaps the reviewed database after checksum verification, and starts the recorded predecessor image tags.
5. Waits for caddy, api, livekit and web to become healthy.
6. Runs core-only smoke, including authenticated RTC WebSocket verification.
7. Updates current-release.env only after health and smoke pass, then writes a mode-600 rollback log.

If health or smoke fails, leave the additional backup and logs intact and recover from the additional backup after review.

## Recover a failed empty-server bootstrap

Use this only when var/releases/pending-release.env has RECORD_STATE=bootstrap-pending and the candidate volume/marker still matches the recorded Compose ownership. The target SHA is the failed candidate, not a predecessor:

~~~bash
cd /opt/babagan-meeting
FAILED_SHA='<pending-release.env 中的 CANDIDATE_SHA>'
sudo bash scripts/rollback.sh \
  --recover-pending-deploy \
  --target-release-sha "$FAILED_SHA" \
  --confirm-rollback "$FAILED_SHA" \
  --smoke-token-file /root/babagan-secrets/smoke-token
~~~

The script stops only the managed Compose stack, rechecks the candidate volume mountpoint, ownership label and marker, removes that recorded candidate volume, archives the pending record and leaves no release active. A replaced, foreign, unmarked or mismatched volume is refused and left intact.

## What to preserve

Keep these artifacts outside Git:

- failed release SHA, predecessor/candidate SHA, operator and UTC start/finish;
- rollback log under var/releases/rollback;
- the recorded pre-deploy backup and checksum;
- the additional pre-rollback backup and checksum;
- restored database path and integrity-check result;
- override file, image IDs, docker compose ps and service logs;
- health endpoint, smoke output and duration.

Do not delete old image tags or backups after a rollback. Retention cleanup is a separate, reviewed maintenance task.

## Backup and restore tools

Online SQLite backup:

~~~bash
sudo bash scripts/backup.sh \
  /var/lib/docker/volumes/babagan-meeting_api-data/_data/meetings.sqlite \
  /opt/babagan-meeting/var/backups 7
~~~

Verified restore creates a new file and never replaces the live database:

~~~bash
sudo bash scripts/restore.sh \
  /opt/babagan-meeting/var/backups/meetings-<UTC>.sqlite \
  /opt/babagan-meeting/var/restore
~~~

Review checksum and PRAGMA integrity_check before any explicit file swap in a stopped-API maintenance window.
