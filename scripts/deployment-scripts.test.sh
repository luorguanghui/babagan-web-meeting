#!/usr/bin/env bash
# Regression checks for deployment transaction and rollback provenance guards.
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
deploy="$root/scripts/deploy.sh"
image_policy="$root/scripts/image-policy.sh"
firewall_attestation="$root/scripts/firewall-attestation.sh"
deployment_smoke="$root/scripts/deployment-smoke.sh"
rollback="$root/scripts/rollback.sh"
compose_file="$root/infra/docker-compose.yml"
api_dockerfile="$root/apps/api/Dockerfile"
web_dockerfile="$root/apps/web/Dockerfile"
need() { grep -Fq -- "$2" "$1" || { echo "missing regression guard: $2" >&2; exit 1; }; }

# Every helper invoked as a command must retain Git's executable bit. This
# catches release bundles that would pass content tests but fail on the host
# before the protected database backup can be created.
for helper in backup.sh restore.sh smoke-test.sh deployment-smoke.sh; do
  mode="$(git -C "$root" ls-files -s "scripts/$helper" | awk '{print $1}')"
  [[ "$mode" == 100755 ]] || { echo "deployment helper is not executable in Git: scripts/$helper ($mode)" >&2; exit 1; }
done

# Failed candidate deployments retain this protected record before any pull/build
# or migration, and only archive it after smoke success.
need "$deploy" 'pending-release.env'
need "$deploy" 'compose pull --policy missing caddy livekit'
need "$deploy" 'compose run --rm --no-deps api'
need "$deploy" 'mv "$pending" "$state_dir/releases/$sha.pending-completed.env"'
need "$deploy" 'PREVIOUS_API_IMAGE_ID'
need "$deploy" 'DATABASE_BACKUP_SHA256'
need "$deploy" '(( mem_kib >= 1153434 ))'
need "$deploy" 'LIVEKIT_NODE_IP must equal the confirmed target IP'
need "$deploy" 'source "$script_dir/image-policy.sh"'
need "$deploy" 'assert_minimum_image_version "$livekit_image" 1.11.0'
need "$deploy" 'Caddy image must remain pinned to the approved digest'
need "$deploy" 'Node image must remain pinned to the approved digest'
need "$compose_file" 'NODE_IMAGE: "${NODE_IMAGE:-node:24.15.0-alpine3.23@sha256:'
need "$compose_file" 'ALPINE_MIRROR: "${ALPINE_MIRROR:-https://mirrors.aliyun.com/alpine}"'
need "$compose_file" 'CADDY_IMAGE: "${CADDY_IMAGE:-caddy:2.10.2-alpine@sha256:'
need "$api_dockerfile" 'ARG NODE_IMAGE=node:24.15.0-alpine3.23@sha256:'
need "$api_dockerfile" 'FROM ${NODE_IMAGE} AS build'
need "$api_dockerfile" 'ARG ALPINE_MIRROR=https://mirrors.aliyun.com/alpine'
need "$api_dockerfile" 's#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR}#g'
need "$api_dockerfile" 'FROM ${NODE_IMAGE} AS runtime'
need "$api_dockerfile" 'pnpm --filter @meeting/contracts build'
need "$web_dockerfile" 'ARG NODE_IMAGE=node:24.15.0-alpine3.23@sha256:'
need "$web_dockerfile" 'ARG CADDY_IMAGE=caddy:2.10.2-alpine@sha256:'
need "$web_dockerfile" 'FROM ${NODE_IMAGE} AS build'
need "$web_dockerfile" 'FROM ${CADDY_IMAGE}'
need "$web_dockerfile" 'pnpm --filter @meeting/contracts build'
need "$deploy" '"$script_dir/deployment-smoke.sh"'
need "$deployment_smoke" 'SMOKE_NODE_IMAGE="$api_image"'
need "$root/scripts/smoke-test.sh" 'SMOKE_NODE_IMAGE'
need "$root/scripts/smoke-test.sh" 'SMOKE_CORE_ONLY'
need "$root/scripts/smoke-test.sh" 'for websocket_attempt in 1 2 3'
need "$root/scripts/smoke-test.sh" 'sleep 5'
need "$rollback" 'SMOKE_CORE_ONLY=1'
need "$rollback" 'SMOKE_NODE_IMAGE="$PREVIOUS_API_IMAGE_TAG"'
need "$deploy" 'wss://meet.babagan.cloud/rtc'
need "$rollback" 'wss://meet.babagan.cloud/rtc'
need "$deploy" 'compose config | awk -v service="$1"'

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
cp "$image_policy" "$temp_dir/no-baseline/scripts/image-policy.sh"
cp "$firewall_attestation" "$temp_dir/no-baseline/scripts/firewall-attestation.sh"
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
cp "$image_policy" "$temp_dir/tampered/scripts/image-policy.sh"
cp "$firewall_attestation" "$temp_dir/tampered/scripts/firewall-attestation.sh"
cp "$root/scripts/release-provenance.sh" "$temp_dir/tampered/scripts/release-provenance.sh"
printf 'RELEASE_SHA=$(touch %s)\n' "$temp_dir/tampered-write-sentinel" >"$temp_dir/tampered/var/releases/current-release.env"
if bash "$temp_dir/tampered/scripts/deploy.sh" \
  --confirm-deploy aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --target-ip 203.0.113.10 \
  --smoke-token-file /not-read --network-evidence /not-read --cloudflare-evidence /not-read; then
  echo 'deploy incorrectly accepted a tampered baseline release record' >&2; exit 1
fi
[[ ! -e "$temp_dir/tampered-write-sentinel" ]] || { echo 'tampered record payload was executed' >&2; exit 1; }
[[ ! -e "$temp_dir/tampered/var/backups" && ! -e "$temp_dir/tampered/var/releases/pending-release.env" ]] || { echo 'tampered baseline deploy created deployment state' >&2; exit 1; }

# Invoke rollback.sh's destructive bootstrap branch with a Docker mock. A
# replaced/foreign volume must stop before compose down or volume rm; the exact
# recorded marker/label/mountpoint is the only case permitted to remove it.
recovery_app="$temp_dir/recovery-app"; mkdir -p "$recovery_app/scripts" "$recovery_app/infra" "$recovery_app/var/releases" "$recovery_app/bin"
cp "$rollback" "$recovery_app/scripts/rollback.sh"; cp "$root/scripts/release-provenance.sh" "$recovery_app/scripts/release-provenance.sh"
printf 'x\n' >"$recovery_app/infra/docker-compose.yml"; printf 'x\n' >"$recovery_app/infra/.env.production"; printf 'token\n' >"$recovery_app/token"
cat >"$recovery_app/bin/stat" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == -c && "$2" == '%a' ]] && { printf '600\n'; exit 0; }; exec /usr/bin/stat "$@"
EOF
cat >"$recovery_app/bin/sqlite3" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$recovery_app/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"
if [[ "$1" == compose ]]; then exit 0; fi
if [[ "$1" == volume && "$2" == inspect ]]; then
  if [[ "$MOCK_VOLUME_MODE" == foreign ]]; then
    [[ "$4" == *Labels* ]] && { printf 'foreign-project\n'; exit 0; }; printf '%s\n' /foreign/replaced; exit 0
  fi
  if [[ "$MOCK_VOLUME_MODE" == replaced-after-down ]] && grep -Eq 'compose .* down' "$MOCK_DOCKER_LOG"; then
    [[ "$4" == *Labels* ]] && { printf 'foreign-project\n'; exit 0; }; printf '%s\n' /foreign/replaced; exit 0
  fi
  [[ "$4" == *Labels* ]] && { printf 'babagan-meeting\n'; exit 0; }; printf '%s\n' "$MOCK_CANDIDATE_MOUNT"; exit 0
fi
if [[ "$1" == volume && "$2" == rm ]]; then exit 0; fi
exit 90
EOF
chmod 700 "$recovery_app/bin"/*
candidate_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
write_bootstrap_pending() {
  cat >"$recovery_app/var/releases/pending-release.env" <<EOF
RECORD_STATE=bootstrap-pending
BOOTSTRAP_EMPTY=1
CANDIDATE_SHA=$candidate_sha
BOOTSTRAP_VOLUME_NAME=babagan-meeting_api-data
BOOTSTRAP_VOLUME_MOUNTPOINT=$1
BOOTSTRAP_VOLUME_PROJECT=babagan-meeting
BOOTSTRAP_VOLUME_MARKER_ID=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
EOF
  sed -i 's/\r$//' "$recovery_app/var/releases/pending-release.env"
}
write_bootstrap_pending /candidate/recorded
foreign_log="$recovery_app/foreign.log"
if PATH="$recovery_app/bin:$PATH" MOCK_DOCKER_LOG="$foreign_log" MOCK_VOLUME_MODE=foreign MOCK_CANDIDATE_MOUNT=/candidate/recorded \
  bash "$recovery_app/scripts/rollback.sh" --recover-pending-deploy --target-release-sha "$candidate_sha" --confirm-rollback "$candidate_sha" --smoke-token-file "$recovery_app/token"; then
  echo 'foreign bootstrap volume was incorrectly recovered' >&2; exit 1
fi
! grep -Eq 'compose .* down|volume rm' "$foreign_log" || { echo 'foreign bootstrap volume triggered destructive Docker action' >&2; exit 1; }
candidate_mount="$recovery_app/candidate-volume"; mkdir -p "$candidate_mount"
marker_id=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
printf 'CANDIDATE_SHA=%s\nMARKER_ID=%s\n' "$candidate_sha" "$marker_id" >"$candidate_mount/.babagan-bootstrap-$marker_id"
write_bootstrap_pending "$candidate_mount"
success_log="$recovery_app/success.log"
PATH="$recovery_app/bin:$PATH" MOCK_DOCKER_LOG="$success_log" MOCK_VOLUME_MODE=candidate MOCK_CANDIDATE_MOUNT="$candidate_mount" \
  bash "$recovery_app/scripts/rollback.sh" --recover-pending-deploy --target-release-sha "$candidate_sha" --confirm-rollback "$candidate_sha" --smoke-token-file "$recovery_app/token"
grep -Eq 'compose .* down' "$success_log" && grep -Fq 'volume rm babagan-meeting_api-data' "$success_log" || { echo 'recorded bootstrap volume was not cleaned up' >&2; exit 1; }
# Marker must exist and bind both candidate SHA and marker ID before down.
rm -f "$candidate_mount/.babagan-bootstrap-$marker_id"; write_bootstrap_pending "$candidate_mount"
unmarked_log="$recovery_app/unmarked.log"
if PATH="$recovery_app/bin:$PATH" MOCK_DOCKER_LOG="$unmarked_log" MOCK_VOLUME_MODE=candidate MOCK_CANDIDATE_MOUNT="$candidate_mount" \
  bash "$recovery_app/scripts/rollback.sh" --recover-pending-deploy --target-release-sha "$candidate_sha" --confirm-rollback "$candidate_sha" --smoke-token-file "$recovery_app/token"; then echo 'unmarked volume was incorrectly recovered' >&2; exit 1; fi
! grep -Eq 'compose .* down|volume rm' "$unmarked_log" || { echo 'unmarked volume triggered destructive action' >&2; exit 1; }
printf 'CANDIDATE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nMARKER_ID=%s\n' "$marker_id" >"$candidate_mount/.babagan-bootstrap-$marker_id"; write_bootstrap_pending "$candidate_mount"
mismatch_log="$recovery_app/mismatch.log"
if PATH="$recovery_app/bin:$PATH" MOCK_DOCKER_LOG="$mismatch_log" MOCK_VOLUME_MODE=candidate MOCK_CANDIDATE_MOUNT="$candidate_mount" \
  bash "$recovery_app/scripts/rollback.sh" --recover-pending-deploy --target-release-sha "$candidate_sha" --confirm-rollback "$candidate_sha" --smoke-token-file "$recovery_app/token"; then echo 'mismatched marker was incorrectly recovered' >&2; exit 1; fi
! grep -Eq 'compose .* down|volume rm' "$mismatch_log" || { echo 'mismatched marker triggered destructive action' >&2; exit 1; }
printf 'CANDIDATE_SHA=%s\nMARKER_ID=%s\n' "$candidate_sha" "$marker_id" >"$candidate_mount/.babagan-bootstrap-$marker_id"; write_bootstrap_pending "$candidate_mount"
replaced_log="$recovery_app/replaced-after-down.log"
if PATH="$recovery_app/bin:$PATH" MOCK_DOCKER_LOG="$replaced_log" MOCK_VOLUME_MODE=replaced-after-down MOCK_CANDIDATE_MOUNT="$candidate_mount" \
  bash "$recovery_app/scripts/rollback.sh" --recover-pending-deploy --target-release-sha "$candidate_sha" --confirm-rollback "$candidate_sha" --smoke-token-file "$recovery_app/token"; then echo 'post-down replaced volume was incorrectly recovered' >&2; exit 1; fi
grep -Eq 'compose .* down' "$replaced_log" && ! grep -Fq 'volume rm babagan-meeting_api-data' "$replaced_log" || { echo 'post-down replacement did not stop before volume removal' >&2; exit 1; }
echo 'deployment transaction/provenance regression checks passed'
