#!/usr/bin/env bash
# Safe target-host deployment. It refuses to substitute local guesses for cloud evidence.
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
app_dir="$(cd "$script_dir/.." && pwd -P)"
# shellcheck source=release-provenance.sh
source "$script_dir/release-provenance.sh"
usage() { echo "Usage: $0 --confirm-deploy SHA --target-ip IPV4 --smoke-token-file FILE --network-evidence FILE --cloudflare-evidence FILE [--env-file FILE]" >&2; exit 64; }
fail() { echo "DEPLOY PREFLIGHT FAILED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || fail "missing command: $1"; }
need_file() { [[ -s "$1" ]] || fail "missing non-empty file: $1"; }
sha='' target_ip='' token_file='' network_file='' cloudflare_file='' env_file=''
while (($#)); do case "$1" in
  --confirm-deploy) sha="${2:-}"; shift 2 ;; --target-ip) target_ip="${2:-}"; shift 2 ;;
  --smoke-token-file) token_file="${2:-}"; shift 2 ;; --network-evidence) network_file="${2:-}"; shift 2 ;;
  --cloudflare-evidence) cloudflare_file="${2:-}"; shift 2 ;; --env-file) env_file="${2:-}"; shift 2 ;; *) usage ;; esac; done
[[ -n "$sha" && -n "$target_ip" && -n "$token_file" && -n "$network_file" && -n "$cloudflare_file" ]] || usage
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail 'confirmation must be a full 40-character Git SHA'
[[ "$target_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'target IP must be IPv4'
env_file="${env_file:-$app_dir/infra/.env.production}"; compose_file="$app_dir/infra/docker-compose.yml"; state_dir="$app_dir/var/releases"; backup_dir="$app_dir/var/backups"
compose() { docker compose --env-file "$env_file" -f "$compose_file" "$@"; }
need docker; need sqlite3; need sha256sum; need getent; need ss; need git; need curl
. /etc/os-release; [[ "${ID:-}" == debian && "${VERSION_ID:-}" == 12* ]] || fail 'target must run Debian 12'
need_file "$env_file"; [[ "$(stat -c '%a' "$env_file")" == 600 ]] || fail 'production environment file must have mode 600'
grep -Eq 'replace-with|development-only|change-me|example-'secret "$env_file" && fail 'production environment contains example values'
for key in PUBLIC_BASE_URL LIVEKIT_URL LIVEKIT_INTERNAL_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET ADMIN_PASSWORD_HASH COOKIE_SECRET; do grep -Eq "^${key}=.+" "$env_file" || fail "missing $key"; done
[[ "$(git -C "$app_dir" rev-parse HEAD)" == "$sha" ]] || fail 'confirmation SHA does not equal checked-out release'
mem_kib="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"; disk_kib="$(df -Pk "$app_dir" | awk 'NR==2 {print $4}')"
(( mem_kib >= 1572864 )) || fail 'requires at least 1.5 GiB available RAM'; (( disk_kib >= 10485760 )) || fail 'requires at least 10 GiB free disk'
getent ahostsv4 meet.babagan.cloud >/dev/null || fail 'meet DNS does not resolve'
for host in rtc.babagan.cloud turn.babagan.cloud; do getent ahostsv4 "$host" | awk '{print $1}' | grep -Fxq "$target_ip" || fail "$host must resolve to target IP"; done
# meet is intentionally Cloudflare-proxied, so it must not be required to return origin IP.
need_file "$network_file"; need_file "$cloudflare_file"
grep -Fqx 'Alibaba inbound: TCP 80,443,7881; UDP 443,50000-60000; SSH restricted' "$network_file" || fail 'missing Alibaba firewall attestation'
grep -Fqx 'Host firewall: TCP 80,443,7881; UDP 443,50000-60000; SSH restricted; default deny inbound' "$network_file" || fail 'missing host firewall attestation'
grep -Fqx 'Cloudflare: meet proxied; rtc DNS-only; turn DNS-only; SSL/TLS Full (strict)' "$cloudflare_file" || fail 'missing Cloudflare attestation'
need_file "$token_file"; [[ "$(stat -c '%a' "$token_file")" == 600 ]] || fail 'smoke token file must have mode 600'
compose config -q || fail 'invalid Docker Compose configuration'
for spec in '80 t' '443 t' '7881 t' '443 u' '50000 u' '60000 u'; do
  read -r port protocol <<<"$spec"
  if ss -H -l"$protocol" | awk -v p="$port" '$4 ~ (":" p "$") || $4 ~ ("\\]" p "$") {found=1} END {exit !found}'; then
    mapfile -t owners < <(docker ps -q --filter "publish=$port")
    ((${#owners[@]})) || fail "port $port/$protocol is occupied outside Docker Compose"
    for owner in "${owners[@]}"; do docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$owner" | grep -Fxq 'babagan-meeting' || fail "port $port/$protocol belongs to another project"; done
  fi
done
volume="$(docker volume inspect --format '{{ .Mountpoint }}' babagan-meeting_api-data 2>/dev/null || true)"
[[ -n "$volume" && -f "$volume/meetings.sqlite" ]] || fail 'a verified baseline API database is required before deployment'
[[ ! -e "$state_dir/pending-release.env" ]] || fail 'a previous deployment is pending recovery; run guarded rollback or archive its evidence before another deploy'
# All preflights above are read-only. The first mutation is a checksummed backup.
umask 077; mkdir -p "$state_dir/releases" "$backup_dir"; chmod 700 "$state_dir" "$state_dir/releases" "$backup_dir"
backup_output="$("$script_dir/backup.sh" "$volume/meetings.sqlite" "$backup_dir")"; backup="${backup_output#Backup created: }"
[[ -f "$backup" && -f "$backup.sha256" ]] || fail 'backup did not create database and checksum'
previous="$state_dir/current-release.env"
load_verified_baseline_release "$previous" || fail 'deployment requires a protected, verified baseline current-release record before backup'
previous_sha="$RELEASE_SHA"; previous_api="$API_IMAGE_TAG"; previous_web="$WEB_IMAGE_TAG"; previous_caddy="$CADDY_IMAGE_TAG"; previous_livekit="$LIVEKIT_IMAGE_TAG"
previous_api_id="$API_IMAGE_ID"; previous_web_id="$WEB_IMAGE_ID"; previous_caddy_id="$CADDY_IMAGE_ID"; previous_livekit_id="$LIVEKIT_IMAGE_ID"
# Persist a protected transaction record before pull/build/migration. On any
# later failure it is the sole guarded recovery source, even though current-release still names the predecessor.
pending="$state_dir/pending-release.env"
pending_tmp="$pending.$$.tmp"
{
  printf 'RECORD_STATE=%q\n' pending
  printf 'CANDIDATE_SHA=%q\n' "$sha"
  printf 'STARTED_AT_UTC=%q\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'DATABASE_BACKUP=%q\n' "$backup"
  printf 'DATABASE_BACKUP_SHA256=%q\n' "$(awk '{print $1}' "$backup.sha256")"
  printf 'PREVIOUS_RELEASE_SHA=%q\n' "$previous_sha"
  printf 'PREVIOUS_API_IMAGE_TAG=%q\n' "$previous_api"; printf 'PREVIOUS_API_IMAGE_ID=%q\n' "$previous_api_id"
  printf 'PREVIOUS_WEB_IMAGE_TAG=%q\n' "$previous_web"; printf 'PREVIOUS_WEB_IMAGE_ID=%q\n' "$previous_web_id"
  printf 'PREVIOUS_CADDY_IMAGE_TAG=%q\n' "$previous_caddy"; printf 'PREVIOUS_CADDY_IMAGE_ID=%q\n' "$previous_caddy_id"
  printf 'PREVIOUS_LIVEKIT_IMAGE_TAG=%q\n' "$previous_livekit"; printf 'PREVIOUS_LIVEKIT_IMAGE_ID=%q\n' "$previous_livekit_id"
} >"$pending_tmp"
chmod 600 "$pending_tmp"; mv "$pending_tmp" "$pending"
compose pull caddy livekit; compose build --pull api web
# One-shot migration: no listening service is started by this command.
compose run --rm --no-deps api node --input-type=module -e 'import {createDatabase} from "./dist/db/database.js"; import {migrate} from "./dist/db/migrate.js"; const db=createDatabase(process.env.DATABASE_PATH); try { migrate(db); } finally { db.close(); }'
image_id() { compose images -q "$1" | head -n 1; }
for service in api web caddy livekit; do id="$(image_id "$service")"; [[ -n "$id" ]] || fail "cannot find image for $service"; docker tag "$id" "babagan-meeting-$service:release-$sha"; done
override="$state_dir/releases/$sha.compose.override.yml"
cat >"$override" <<EOF
services:
  api: { image: babagan-meeting-api:release-$sha }
  web: { image: babagan-meeting-web:release-$sha }
  caddy: { image: babagan-meeting-caddy:release-$sha }
  livekit: { image: babagan-meeting-livekit:release-$sha }
EOF
chmod 600 "$override"; compose -f "$override" up -d --no-build
deadline=$((SECONDS+180)); healthy=0
while ((SECONDS<deadline)); do
  healthy=1
  for service in caddy api livekit web; do id="$(compose ps -q "$service")"; status="${id:+$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")}"; [[ "$status" == healthy ]] || healthy=0; done
  ((healthy)) && break; sleep 3
done
((healthy)) || { compose ps >&2; fail 'health wait exceeded 180 seconds'; }
token="$(<"$token_file")"; [[ -n "$token" ]] || fail 'smoke token is empty'; SMOKE_LIVEKIT_TOKEN="$token" "$script_dir/smoke-test.sh" https://meet.babagan.cloud wss://rtc.babagan.cloud; unset token
record="$state_dir/releases/$sha.env"
{
 printf 'RELEASE_SHA=%q\n' "$sha"; printf 'DEPLOYED_AT_UTC=%q\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; printf 'DATABASE_BACKUP=%q\n' "$backup"; printf 'DATABASE_BACKUP_SHA256=%q\n' "$(awk '{print $1}' "$backup.sha256")"; printf 'OVERRIDE_FILE=%q\n' "$override"
 for service in api web caddy livekit; do upper="$(tr '[:lower:]' '[:upper:]' <<<"$service")"; printf '%s_IMAGE_TAG=%q\n' "$upper" "babagan-meeting-$service:release-$sha"; printf '%s_IMAGE_ID=%q\n' "$upper" "$(image_id "$service")"; done
 printf 'PREVIOUS_RELEASE_SHA=%q\n' "$previous_sha"; printf 'PREVIOUS_API_IMAGE_TAG=%q\n' "$previous_api"; printf 'PREVIOUS_API_IMAGE_ID=%q\n' "$previous_api_id"; printf 'PREVIOUS_WEB_IMAGE_TAG=%q\n' "$previous_web"; printf 'PREVIOUS_WEB_IMAGE_ID=%q\n' "$previous_web_id"; printf 'PREVIOUS_CADDY_IMAGE_TAG=%q\n' "$previous_caddy"; printf 'PREVIOUS_CADDY_IMAGE_ID=%q\n' "$previous_caddy_id"; printf 'PREVIOUS_LIVEKIT_IMAGE_TAG=%q\n' "$previous_livekit"; printf 'PREVIOUS_LIVEKIT_IMAGE_ID=%q\n' "$previous_livekit_id"
} >"$record"
chmod 600 "$record"; cp "$record" "$previous"; chmod 600 "$previous"; mv "$pending" "$state_dir/releases/$sha.pending-completed.env"; chmod 600 "$state_dir/releases/$sha.pending-completed.env"
echo "DEPLOY SUCCEEDED: $sha"; echo "Release record: $record"; echo "Backup: $backup"
