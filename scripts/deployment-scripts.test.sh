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
chmod 600 "$temp_dir/pending-release.env"
load_verified_pending_deployment "$temp_dir/pending-release.env"
sed -i '/PREVIOUS_WEB_IMAGE_ID/d' "$temp_dir/pending-release.env"
if load_verified_pending_deployment "$temp_dir/pending-release.env"; then
  echo 'incomplete pending recovery record was incorrectly accepted' >&2; exit 1
fi
echo 'deployment transaction/provenance regression checks passed'
