#!/usr/bin/env bash
# Regression checks for deployment transaction and rollback provenance guards.
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
deploy="$root/scripts/deploy.sh"
rollback="$root/scripts/rollback.sh"
need() { grep -Fq -- "$2" "$1" || { echo "missing regression guard: $2" >&2; exit 1; }; }

# Failed candidate deployments retain this protected record before any pull/build
# or migration, and only archive it after smoke success.
need "$deploy" 'pending-release.env'
need "$deploy" 'compose pull caddy livekit'
need "$deploy" 'compose run --rm --no-deps api'
need "$deploy" 'mv "$pending" "$state_dir/releases/$sha.pending-completed.env"'
need "$deploy" 'PREVIOUS_API_IMAGE_ID'
need "$deploy" 'DATABASE_BACKUP_SHA256'

# The recovery path must be explicit; a normal rollback cannot accidentally use
# a pending deployment. Both database and image provenance are checked before
# compose stop or the SQLite replacement.
need "$rollback" '--recover-pending-deploy'
need "$rollback" 'source_record="$state_dir/pending-release.env"'
need "$rollback" 'sha256sum "$DATABASE_BACKUP"'
need "$rollback" 'recorded image tag does not resolve to its immutable ID'
checksum_line="$(grep -nF 'sha256sum "$DATABASE_BACKUP"' "$rollback" | head -n1 | cut -d: -f1)"
stop_line="$(grep -nF 'compose stop api' "$rollback" | head -n1 | cut -d: -f1)"
[[ -n "$checksum_line" && -n "$stop_line" && "$checksum_line" -lt "$stop_line" ]] || { echo 'checksum guard must run before destructive rollback' >&2; exit 1; }

# Execute the shared validation used by deploy/rollback under a mock Docker
# binary. This proves a missing first-deploy baseline is rejected, while a
# complete baseline and a complete pending-recovery record are accepted.
temp_dir="$(mktemp -d)"; trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin"
# Execute deploy.sh itself from an otherwise empty app root. Its baseline gate
# must stop before Docker/host preflights and before it creates var/, backups,
# or release state.
mkdir -p "$temp_dir/no-baseline/scripts"
cp "$deploy" "$temp_dir/no-baseline/scripts/deploy.sh"
cp "$root/scripts/release-provenance.sh" "$temp_dir/no-baseline/scripts/release-provenance.sh"
if bash "$temp_dir/no-baseline/scripts/deploy.sh" \
  --confirm-deploy aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --target-ip 203.0.113.10 \
  --smoke-token-file /not-read --network-evidence /not-read --cloudflare-evidence /not-read; then
  echo 'deploy incorrectly accepted a missing baseline release record' >&2; exit 1
fi
[[ ! -e "$temp_dir/no-baseline/var" ]] || { echo 'missing-baseline deploy created release or backup state' >&2; exit 1; }
bootstrap_output="$(bash "$temp_dir/no-baseline/scripts/deploy.sh" \
  --bootstrap-empty --confirm-deploy aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --target-ip 203.0.113.10 \
  --smoke-token-file /not-read --network-evidence /not-read --cloudflare-evidence /not-read 2>&1 || true)"
[[ "$bootstrap_output" != *'baseline current-release'* ]] || { echo 'explicit bootstrap path did not bypass baseline requirement' >&2; exit 1; }
[[ ! -e "$temp_dir/no-baseline/var" ]] || { echo 'bootstrap host-preflight failure created release or backup state' >&2; exit 1; }
cat >"$temp_dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == image && "$2" == inspect ]] || exit 90
printf '%s\n' sha256:immutable
EOF
chmod 700 "$temp_dir/bin/docker"
cat >"$temp_dir/bin/stat" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == -c && "$2" == '%a' ]] && { printf '%s\n' 600; exit 0; }
exec /usr/bin/stat "$@"
EOF
chmod 700 "$temp_dir/bin/stat"
PATH="$temp_dir/bin:$PATH"
# shellcheck source=release-provenance.sh
source "$root/scripts/release-provenance.sh"
if load_verified_baseline_release "$temp_dir/no-current-release.env"; then
  echo 'missing baseline release record was incorrectly accepted' >&2; exit 1
fi
cat >"$temp_dir/current-release.env" <<'EOF'
RELEASE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
API_IMAGE_TAG=meeting-api:baseline
API_IMAGE_ID=sha256:immutable
WEB_IMAGE_TAG=meeting-web:baseline
WEB_IMAGE_ID=sha256:immutable
CADDY_IMAGE_TAG=meeting-caddy:baseline
CADDY_IMAGE_ID=sha256:immutable
LIVEKIT_IMAGE_TAG=meeting-livekit:baseline
LIVEKIT_IMAGE_ID=sha256:immutable
EOF
sed -i 's/\r$//' "$temp_dir/current-release.env"
chmod 600 "$temp_dir/current-release.env"
load_verified_baseline_release "$temp_dir/current-release.env"
cat >"$temp_dir/pending-release.env" <<'EOF'
RECORD_STATE=pending
CANDIDATE_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PREVIOUS_RELEASE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
DATABASE_BACKUP=/protected/meetings.sqlite
DATABASE_BACKUP_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PREVIOUS_API_IMAGE_TAG=meeting-api:baseline
PREVIOUS_API_IMAGE_ID=sha256:immutable
PREVIOUS_WEB_IMAGE_TAG=meeting-web:baseline
PREVIOUS_WEB_IMAGE_ID=sha256:immutable
PREVIOUS_CADDY_IMAGE_TAG=meeting-caddy:baseline
PREVIOUS_CADDY_IMAGE_ID=sha256:immutable
PREVIOUS_LIVEKIT_IMAGE_TAG=meeting-livekit:baseline
PREVIOUS_LIVEKIT_IMAGE_ID=sha256:immutable
EOF
sed -i 's/\r$//' "$temp_dir/pending-release.env"
chmod 600 "$temp_dir/pending-release.env"
load_verified_pending_deployment "$temp_dir/pending-release.env"
sed -i '/PREVIOUS_WEB_IMAGE_ID/d' "$temp_dir/pending-release.env"
if load_verified_pending_deployment "$temp_dir/pending-release.env"; then
  echo 'incomplete pending recovery record was incorrectly accepted' >&2; exit 1
fi
cat >"$temp_dir/bootstrap-pending.env" <<'EOF'
RECORD_STATE=bootstrap-pending
BOOTSTRAP_EMPTY=1
CANDIDATE_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
EOF
sed -i 's/\r$//' "$temp_dir/bootstrap-pending.env"
chmod 600 "$temp_dir/bootstrap-pending.env"
load_verified_pending_deployment "$temp_dir/bootstrap-pending.env"
[[ "$IS_BOOTSTRAP_PENDING" == 1 ]] || { echo 'bootstrap pending record was not identified' >&2; exit 1; }
# Cross-role schemas are mutually exclusive: a pending transaction cannot be
# accepted as a baseline release, and bootstrap cannot carry predecessor state.
if load_verified_baseline_release "$temp_dir/bootstrap-pending.env"; then echo 'bootstrap transaction was accepted as baseline' >&2; exit 1; fi
# A tampered baseline must never be sourced. The payload would create this
# sentinel if record parsing evaluated shell syntax. Run deploy.sh itself and
# ensure it fails without deployment state or any payload side effect.
mkdir -p "$temp_dir/tampered/scripts" "$temp_dir/tampered/var/releases"
cp "$deploy" "$temp_dir/tampered/scripts/deploy.sh"
cp "$root/scripts/release-provenance.sh" "$temp_dir/tampered/scripts/release-provenance.sh"
printf 'RELEASE_SHA=$(touch %s)\n' "$temp_dir/tampered-write-sentinel" >"$temp_dir/tampered/var/releases/current-release.env"
if bash "$temp_dir/tampered/scripts/deploy.sh" \
  --confirm-deploy aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --target-ip 203.0.113.10 \
  --smoke-token-file /not-read --network-evidence /not-read --cloudflare-evidence /not-read; then
  echo 'deploy incorrectly accepted a tampered baseline release record' >&2; exit 1
fi
[[ ! -e "$temp_dir/tampered-write-sentinel" ]] || { echo 'tampered record payload was executed' >&2; exit 1; }
[[ ! -e "$temp_dir/tampered/var/backups" && ! -e "$temp_dir/tampered/var/releases/pending-release.env" ]] || { echo 'tampered baseline deploy created deployment state' >&2; exit 1; }
echo 'deployment transaction/provenance regression checks passed'
