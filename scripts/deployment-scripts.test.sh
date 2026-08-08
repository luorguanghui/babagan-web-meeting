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
echo 'deployment transaction/provenance regression checks passed'
