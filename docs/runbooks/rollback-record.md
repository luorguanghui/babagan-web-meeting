# Production rollback record

Do not roll back during an active meeting. This committed template contains no
target-server execution evidence.

| Field | Value |
|---|---|
| Failed release SHA / predecessor SHA | Pending target-server execution |
| Operator and UTC start/finish | Pending target-server execution |
| Recorded database checksum | Pending target-server execution |
| Restored image tags/IDs | Pending target-server execution |
| Health, smoke and duration | Pending target-server execution |

Run only when the protected current-release record names the requested SHA as
its direct predecessor. The confirmation repeats the intended destructive target:

```bash
bash scripts/rollback.sh --target-release-sha '<40-character SHA>' \
  --confirm-rollback '<same 40-character SHA>' \
  --smoke-token-file /protected/smoke-token
```

If a candidate deploy failed after its pre-deploy backup but before smoke-test
promotion, recover the preserved predecessor explicitly instead of relying on
the older `current-release.env` record:

```bash
bash scripts/rollback.sh --recover-pending-deploy \
  --target-release-sha '<recorded predecessor SHA>' \
  --confirm-rollback '<same predecessor SHA>' \
  --smoke-token-file /protected/smoke-token
```

The script creates another backup of the failed database, verifies and restores
the selected transaction's pre-deploy backup, recomputes its checksum against
the recorded checksum, verifies each predecessor tag still resolves to its
recorded immutable image ID, then starts only those predecessor image tags,
waits for health, and runs smoke tests. Preserve the generated
`var/releases/rollback/*.log`, both backup/checksum pairs, and command output.
If health or smoke fails, stop and recover using the additional backup; do not
delete image sets or backups.

No restore or rollback rehearsal has been executed from this workspace because
no host access was supplied. Approval remains blocked until target-host restore
and rollback rehearsals have exact timestamps, commands, checksums, image IDs,
duration, and result recorded here.
