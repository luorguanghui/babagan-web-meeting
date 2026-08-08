#!/usr/bin/env bash
# Destructive rollback: only the recorded direct predecessor may be selected.
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
app_dir="$(cd "$script_dir/.." && pwd -P)"
# shellcheck source=release-provenance.sh
source "$script_dir/release-provenance.sh"
usage() { echo "Usage: $0 --target-release-sha SHA --confirm-rollback SHA --smoke-token-file FILE [--recover-pending-deploy] [--env-file FILE]" >&2; exit 64; }
fail() { echo "ROLLBACK REFUSED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || fail "missing command: $1"; }
need_file() { [[ -s "$1" ]] || fail "missing non-empty file: $1"; }
target='' confirm='' token_file='' env_file='' recover_pending=0
while (($#)); do case "$1" in
  --target-release-sha) target="${2:-}"; shift 2 ;; --confirm-rollback) confirm="${2:-}"; shift 2 ;;
  --smoke-token-file) token_file="${2:-}"; shift 2 ;; --recover-pending-deploy) recover_pending=1; shift ;; --env-file) env_file="${2:-}"; shift 2 ;; *) usage ;; esac; done
[[ -n "$target" && -n "$confirm" && -n "$token_file" ]] || usage
[[ "$target" == "$confirm" && "$target" =~ ^[0-9a-f]{40}$ ]] || fail 'confirmation must exactly repeat a full target release SHA'
env_file="${env_file:-$app_dir/infra/.env.production}"; compose_file="$app_dir/infra/docker-compose.yml"; state_dir="$app_dir/var/releases"; current="$state_dir/current-release.env"
compose() { docker compose --env-file "$env_file" -f "$compose_file" "$@"; }
need docker; need sqlite3; need sha256sum; need curl
need_file "$env_file"; [[ "$(stat -c '%a' "$env_file")" == 600 ]] || fail 'production environment file must have mode 600'
need_file "$token_file"; [[ "$(stat -c '%a' "$token_file")" == 600 ]] || fail 'smoke token file must have mode 600'
compose config -q || fail 'invalid Docker Compose configuration'
source_record="$current"
bootstrap_recovery=0
if (( recover_pending )); then
  source_record="$state_dir/pending-release.env"
  load_verified_pending_deployment "$source_record" || fail 'pending recovery record is invalid'
  bootstrap_recovery="$IS_BOOTSTRAP_PENDING"
else
  load_verified_baseline_release "$current" || fail 'current release record is invalid'
fi
if (( bootstrap_recovery )); then
  [[ "$target" == "$CANDIDATE_SHA" ]] || fail 'bootstrap recovery confirmation must name the failed candidate SHA'
  umask 077; mkdir -p "$state_dir/rollback"; chmod 700 "$state_dir" "$state_dir/rollback"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"; log="$state_dir/rollback/$stamp-bootstrap-$target.log"
  # The bootstrap preflight proved no predecessor DB/stack existed. Explicit
  # recovery removes only the candidate-managed stack and its newly-created DB volume.
  compose down --remove-orphans
  bootstrap_volume="$(docker volume inspect --format '{{ .Mountpoint }}' babagan-meeting_api-data 2>/dev/null || true)"
  [[ -z "$bootstrap_volume" ]] || docker volume rm babagan-meeting_api-data >/dev/null
  mv "$source_record" "$state_dir/rollback/pending-bootstrap.recovered-$stamp.env"
  printf 'RESULT=bootstrap-recovered-no-release\nCANDIDATE_SHA=%s\nCOMPLETED_AT_UTC=%s\n' "$target" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$log"
  chmod 600 "$log"; echo "BOOTSTRAP RECOVERY SUCCEEDED: no release remains"; exit 0
fi
[[ "${PREVIOUS_RELEASE_SHA:-}" == "$target" ]] || fail 'target is not the recorded predecessor of selected release record'
for key in DATABASE_BACKUP DATABASE_BACKUP_SHA256 PREVIOUS_API_IMAGE_TAG PREVIOUS_API_IMAGE_ID PREVIOUS_WEB_IMAGE_TAG PREVIOUS_WEB_IMAGE_ID PREVIOUS_CADDY_IMAGE_TAG PREVIOUS_CADDY_IMAGE_ID PREVIOUS_LIVEKIT_IMAGE_TAG PREVIOUS_LIVEKIT_IMAGE_ID; do [[ -n "${!key:-}" ]] || fail "record lacks $key"; done
need_file "$DATABASE_BACKUP"; need_file "$DATABASE_BACKUP.sha256"
[[ "$(sha256sum "$DATABASE_BACKUP" | awk '{print $1}')" == "$DATABASE_BACKUP_SHA256" ]] || fail 'database backup checksum does not match the recorded transaction checksum'
for service in api web caddy livekit; do
  upper="$(tr '[:lower:]' '[:upper:]' <<<"$service")"; tag_var="PREVIOUS_${upper}_IMAGE_TAG"; id_var="PREVIOUS_${upper}_IMAGE_ID"
  actual_id="$(docker image inspect --format '{{.Id}}' "${!tag_var}" 2>/dev/null || true)"
  [[ -n "$actual_id" && "$actual_id" == "${!id_var}" ]] || fail "recorded image tag does not resolve to its immutable ID: ${!tag_var}"
done
volume="$(docker volume inspect --format '{{ .Mountpoint }}' babagan-meeting_api-data 2>/dev/null || true)"
[[ -n "$volume" && -f "$volume/meetings.sqlite" ]] || fail 'live API database is unavailable'
umask 077; mkdir -p "$state_dir/rollback" "$state_dir/restore"; chmod 700 "$state_dir" "$state_dir/rollback" "$state_dir/restore"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"; log="$state_dir/rollback/$stamp-$target.log"
# Preserve the failing database too; neither this backup nor old images are removed.
current_backup_output="$("$script_dir/backup.sh" "$volume/meetings.sqlite" "$state_dir/rollback")"
current_backup="${current_backup_output#Backup created: }"
restore_output="$("$script_dir/restore.sh" "$DATABASE_BACKUP" "$state_dir/restore")"
restored="$(printf '%s\n' "$restore_output" | sed -n 's/^Verified restore created: //p')"; need_file "$restored"
override="$state_dir/rollback/$stamp-$target.compose.override.yml"
cat >"$override" <<EOF
services:
  api: { image: $PREVIOUS_API_IMAGE_TAG }
  web: { image: $PREVIOUS_WEB_IMAGE_TAG }
  caddy: { image: $PREVIOUS_CADDY_IMAGE_TAG }
  livekit: { image: $PREVIOUS_LIVEKIT_IMAGE_TAG }
EOF
chmod 600 "$override"
echo "Rollback start UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee "$log"
compose stop api
replacement="$volume/.meetings.sqlite.rollback-$stamp"
install -m 600 "$restored" "$replacement"
mv "$volume/meetings.sqlite" "$volume/meetings.sqlite.pre-rollback-$stamp"; mv "$replacement" "$volume/meetings.sqlite"; chown 10001:10001 "$volume/meetings.sqlite"
compose -f "$override" up -d --no-build
deadline=$((SECONDS+180)); healthy=0
while ((SECONDS<deadline)); do
  healthy=1
  for service in caddy api livekit web; do id="$(compose ps -q "$service")"; status="${id:+$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")}"; [[ "$status" == healthy ]] || healthy=0; done
  ((healthy)) && break; sleep 3
done
((healthy)) || { echo 'Health wait failed; recover from the additional backup.' | tee -a "$log" >&2; exit 1; }
token="$(<"$token_file")"; [[ -n "$token" ]] || fail 'smoke token is empty'; SMOKE_LIVEKIT_TOKEN="$token" "$script_dir/smoke-test.sh" https://meet.babagan.cloud wss://rtc.babagan.cloud; unset token
if (( recover_pending )); then
  mv "$source_record" "$state_dir/rollback/pending-release.recovered-$stamp.env"
else
  target_record="$state_dir/releases/$target.env"; need_file "$target_record"; cp "$target_record" "$current"; chmod 600 "$current"
fi
printf 'RESULT=success\nTARGET_RELEASE_SHA=%s\nRECOVERY_SOURCE=%s\nRESTORED_BACKUP=%s\nPRE_ROLLBACK_BACKUP=%s\nCOMPLETED_AT_UTC=%s\n' "$target" "$source_record" "$DATABASE_BACKUP" "$current_backup" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$log"
chmod 600 "$log"; echo "ROLLBACK SUCCEEDED: $target"; echo "Record: $log"
