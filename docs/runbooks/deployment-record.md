# Production deployment record

This is a target-host evidence template, not evidence that production was deployed. Do not include credentials, tokens, participant data, or media.

| Field | Value |
|---|---|
| Release Git SHA | Pending target-server execution |
| Operator and UTC timestamps | Pending target-server execution |
| Image IDs/digests and release record path | Pending target-server execution |
| Database backup path and SHA-256 | Pending target-server execution |

## Mandatory preflight evidence

| Gate | Required evidence | Status |
|---|---|---|
| Debian 12, Docker and Compose | `cat /etc/os-release`, `docker version`, `docker compose version` | Pending target-server execution |
| 1.5 GiB available RAM and 10 GiB disk | `/proc/meminfo` and `df -h` output | Pending target-server execution |
| DNS | `getent ahostsv4 meet.babagan.cloud rtc.babagan.cloud turn.babagan.cloud` | Pending target-server execution |
| Secrets | Generated only on target host, protected file mode 600, no values recorded | Pending target-server execution |
| Alibaba and host firewall | TCP 80/443/7881; UDP 443/50000-60000; SSH restricted; default-deny host inbound | Pending target-server execution |
| Cloudflare | `meet` proxied, `rtc` and `turn` DNS-only, SSL/TLS Full (strict) | Pending target-server execution |
| Backup | checksummed pre-deploy SQLite backup | Pending target-server execution |

## Controlled command

Create protected evidence files containing these exact attestations, with a
separate dated console export or screenshot path recorded beside them:

```bash
Alibaba inbound: TCP 80,443,7881; UDP 443,50000-60000; SSH restricted
Host firewall: TCP 80,443,7881; UDP 443,50000-60000; SSH restricted; default deny inbound
Cloudflare: meet proxied; rtc DNS-only; turn DNS-only; SSL/TLS Full (strict)
```

Then run from the checked-out target release:

```bash
bash scripts/deploy.sh --confirm-deploy "$(git rev-parse HEAD)" --target-ip '<origin IPv4>' \
  --smoke-token-file /protected/smoke-token --network-evidence /protected/network.txt \
  --cloudflare-evidence /protected/cloudflare.txt
```

The script performs all non-mutating checks first, creates a verified backup,
then writes `var/releases/pending-release.env` before pull/build/migration.
That mode-600 transaction record binds the candidate SHA, pre-deploy backup,
and exact predecessor tags plus immutable image IDs. It is promoted only after
health and HTTPS/WSS smoke pass. If deployment fails after this point, do not
start another deployment: use the explicit guarded recovery command in the
rollback record. The script does not prune any image or backup. It refuses a
first deployment without a separately approved protected baseline release
record: that record must name the predecessor Git SHA, all four image tags and
their immutable IDs, and each tag must still resolve to its recorded ID. This
also requires a verified baseline database, so no deploy is permitted where a
recovery target cannot be proven. Release records use a strict allowlisted
`KEY=VALUE` format; deployment and rollback parse them as data and reject
unknown, duplicate, malformed, or shell-like values without evaluating them.

For a genuinely empty first server only, the operator may add
`--bootstrap-empty`. This separate opt-in is refused if a current release
record, managed Compose stack, or API data volume already exists. It writes an
honest `bootstrap-pending` transaction before candidate pull/build/migration;
it does not invent a predecessor backup or image. If that candidate fails, run
the guarded rollback command with `--recover-pending-deploy` and the failed
candidate SHA twice. Bootstrap recovery stops the managed stack, removes only
the newly created API data volume, archives the pending record, and leaves no
release active.

Preserve the generated release record, backup/checksum, `docker compose ... ps`
output, both health endpoint results, and smoke-test output outside Git.
