#!/usr/bin/env bash
# Safe target-host deployment. It refuses to substitute local guesses for cloud evidence.
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
app_dir="$(cd "$script_dir/.." && pwd -P)"
# shellcheck source=release-provenance.sh
source "$script_dir/release-provenance.sh"
# shellcheck source=firewall-attestation.sh
source "$script_dir/firewall-attestation.sh"
# shellcheck source=image-policy.sh
source "$script_dir/image-policy.sh"
usage() { echo "Usage: $0 --confirm-deploy SHA --target-ip IPV4 --smoke-token-file FILE --network-evidence FILE --cloudflare-evidence FILE [--allow-public-ssh] [--bootstrap-empty] [--env-file FILE]" >&2; exit 64; }
fail() { echo "DEPLOY PREFLIGHT FAILED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || fail "missing command: $1"; }
need_file() { [[ -s "$1" ]] || fail "missing non-empty file: $1"; }
sha='' target_ip='' token_file='' network_file='' cloudflare_file='' env_file='' bootstrap_empty=0 allow_public_ssh=0
while (($#)); do case "$1" in
  --confirm-deploy) sha="${2:-}"; shift 2 ;; --target-ip) target_ip="${2:-}"; shift 2 ;;
  --smoke-token-file) token_file="${2:-}"; shift 2 ;; --network-evidence) network_file="${2:-}"; shift 2 ;;
  --cloudflare-evidence) cloudflare_file="${2:-}"; shift 2 ;; --allow-public-ssh) allow_public_ssh=1; shift ;;
  --bootstrap-empty) bootstrap_empty=1; shift ;; --env-file) env_file="${2:-}"; shift 2 ;; *) usage ;; esac; done
[[ -n "$sha" && -n "$target_ip" && -n "$token_file" && -n "$network_file" && -n "$cloudflare_file" ]] || usage
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail 'confirmation must be a full 40-character Git SHA'
[[ "$target_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'target IP must be IPv4'
env_file="${env_file:-$app_dir/infra/.env.production}"; compose_file="$app_dir/infra/docker-compose.yml"; state_dir="$app_dir/var/releases"; backup_dir="$app_dir/var/backups"
compose() { docker compose --env-file "$env_file" -f "$compose_file" "$@"; }
# This is deliberately before every directory creation, chmod, backup, pull or build.
previous="$state_dir/current-release.env"
previous_sha='' previous_api='' previous_web='' previous_caddy='' previous_livekit=''; previous_api_id='' previous_web_id='' previous_caddy_id='' previous_livekit_id=''
if (( bootstrap_empty )); then
  [[ ! -e "$previous" && ! -L "$previous" ]] || fail '--bootstrap-empty requires no current release record (including dangling symlink)'
else
  load_verified_baseline_release "$previous" || fail 'deployment requires a protected, verified baseline current-release record before any mutation'
  previous_sha="$RELEASE_SHA"; previous_api="$API_IMAGE_TAG"; previous_web="$WEB_IMAGE_TAG"; previous_caddy="$CADDY_IMAGE_TAG"; previous_livekit="$LIVEKIT_IMAGE_TAG"
  previous_api_id="$API_IMAGE_ID"; previous_web_id="$WEB_IMAGE_ID"; previous_caddy_id="$CADDY_IMAGE_ID"; previous_livekit_id="$LIVEKIT_IMAGE_ID"
fi
need docker; need sqlite3; need sha256sum; need getent; need ss; need git; need curl
. /etc/os-release; [[ "${ID:-}" == debian && "${VERSION_ID:-}" == 12* ]] || fail 'target must run Debian 12'
need_file "$env_file"; [[ "$(stat -c '%a' "$env_file")" == 600 ]] || fail 'production environment file must have mode 600'
grep -Eq 'replace-with|development-only|change-me|example-'secret "$env_file" && fail 'production environment contains example values'
for key in PUBLIC_BASE_URL LIVEKIT_URL LIVEKIT_INTERNAL_URL LIVEKIT_NODE_IP LIVEKIT_API_KEY LIVEKIT_API_SECRET ADMIN_PASSWORD_HASH COOKIE_SECRET P2P_STUN_URLS P2P_TURN_URLS P2P_TURN_SECRET P2P_TURN_TTL_SECONDS TURN_SHARED_SECRET TURN_EXTERNAL_IP TURN_RELAY_IP; do grep -Eq "^${key}=.+" "$env_file" || fail "missing $key"; done
[[ "$(grep -c '^LIVEKIT_IMAGE=' "$env_file")" -le 1 ]] || fail 'LIVEKIT_IMAGE must appear at most once'
livekit_image="$(sed -n 's/^LIVEKIT_IMAGE=//p' "$env_file")"
livekit_image="${livekit_image:-livekit/livekit-server:v1.11.0@sha256:100b9a870616d02f5e3795b34e0b593b5054a26f8131a94fd3fa322ed3154b16}"
assert_minimum_image_version "$livekit_image" 1.11.0 \
  || fail 'LiveKit image version must be v1.11.0 or newer'
[[ "$(grep -c '^NODE_IMAGE=' "$env_file")" -le 1 ]] || fail 'NODE_IMAGE must appear at most once'
node_image="$(sed -n 's/^NODE_IMAGE=//p' "$env_file")"
node_image="${node_image:-node:24.15.0-alpine3.23@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f}"
[[ "$node_image" =~ ^[^[:space:]]+@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f$ ]] \
  || fail 'Node image must remain pinned to the approved digest'
[[ "$(grep -c '^CADDY_IMAGE=' "$env_file")" -le 1 ]] || fail 'CADDY_IMAGE must appear at most once'
caddy_image="$(sed -n 's/^CADDY_IMAGE=//p' "$env_file")"
caddy_image="${caddy_image:-caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d}"
[[ "$caddy_image" =~ ^[^[:space:]]+@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d$ ]] \
  || fail 'Caddy image must remain pinned to the approved digest'
[[ "$(grep -c '^COTURN_IMAGE=' "$env_file")" -le 1 ]] || fail 'COTURN_IMAGE must appear at most once'
coturn_image="$(sed -n 's/^COTURN_IMAGE=//p' "$env_file")"
coturn_image="${coturn_image:-coturn/coturn:4.17.2-r0@sha256:aa68aab64a3b929d57fc2924c98ea447bf996cf8dade2508e7b71eaf23f1f14e}"
[[ "$coturn_image" =~ ^[^[:space:]]*coturn/coturn:4\.17\.2-r0@sha256:aa68aab64a3b929d57fc2924c98ea447bf996cf8dade2508e7b71eaf23f1f14e$ ]] \
  || fail 'coturn image must remain pinned to the approved digest'
configured_node_ip="$(sed -n 's/^LIVEKIT_NODE_IP=//p' "$env_file")"
[[ "$configured_node_ip" == "$target_ip" ]] || fail 'LIVEKIT_NODE_IP must equal the confirmed target IP'
turn_external_ip="$(sed -n 's/^TURN_EXTERNAL_IP=//p' "$env_file")"
turn_relay_ip="$(sed -n 's/^TURN_RELAY_IP=//p' "$env_file")"
[[ "$turn_external_ip" == "$target_ip" ]] || fail 'TURN_EXTERNAL_IP must equal the confirmed target IP'
[[ "$turn_relay_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'TURN_RELAY_IP must be IPv4'
p2p_turn_secret="$(sed -n 's/^P2P_TURN_SECRET=//p' "$env_file")"
turn_shared_secret="$(sed -n 's/^TURN_SHARED_SECRET=//p' "$env_file")"
[[ ${#p2p_turn_secret} -ge 32 && "$p2p_turn_secret" == "$turn_shared_secret" ]] \
  || fail 'P2P_TURN_SECRET and TURN_SHARED_SECRET must match and contain at least 32 characters'
[[ "$(sed -n 's/^P2P_TURN_TTL_SECONDS=//p' "$env_file")" == 600 ]] \
  || fail 'P2P_TURN_TTL_SECONDS must be 600 in production'
grep -Eq '^P2P_TURN_URLS=.*turn\.babagan\.cloud:3478.*turns:turn\.babagan\.cloud:5349' "$env_file" \
  || fail 'P2P_TURN_URLS must include UDP/TCP TURN and TLS TURN endpoints'
[[ "$(git -C "$app_dir" rev-parse HEAD)" == "$sha" ]] || fail 'confirmation SHA does not equal checked-out release'
mem_kib="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"; disk_kib="$(df -Pk "$app_dir" | awk 'NR==2 {print $4}')"
(( mem_kib >= 1153434 )) || fail 'requires at least 1.1 GiB available RAM'; (( disk_kib >= 10485760 )) || fail 'requires at least 10 GiB free disk'
getent ahostsv4 meet.babagan.cloud >/dev/null || fail 'meet DNS does not resolve'
for host in rtc.babagan.cloud turn.babagan.cloud; do getent ahostsv4 "$host" | awk '{print $1}' | grep -Fxq "$target_ip" || fail "$host must resolve to target IP"; done
# meet is intentionally Cloudflare-proxied, so it must not be required to return origin IP.
need_file "$network_file"; need_file "$cloudflare_file"
verify_firewall_attestation "$network_file" "$allow_public_ssh" || fail 'firewall attestation does not match the selected SSH policy'
grep -Fqx 'Cloudflare: meet proxied; rtc DNS-only; turn DNS-only; SSL/TLS Full (strict)' "$cloudflare_file" || fail 'missing Cloudflare attestation'
need_file "$token_file"; [[ "$(stat -c '%a' "$token_file")" == 600 ]] || fail 'smoke token file must have mode 600'
compose config -q || fail 'invalid Docker Compose configuration'
for spec in '80 t' '443 t' '3478 t' '5349 t' '7881 t' '443 u' '3478 u' '49160 u' '49200 u' '50000 u' '60000 u'; do
  read -r port protocol <<<"$spec"
  if ss -H -l"$protocol" | awk -v p="$port" '$4 ~ (":" p "$") || $4 ~ ("\\]" p "$") {found=1} END {exit !found}'; then
    mapfile -t owners < <(docker ps -q --filter "publish=$port")
    ((${#owners[@]})) || fail "port $port/$protocol is occupied outside Docker Compose"
    for owner in "${owners[@]}"; do docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$owner" | grep -Fxq 'babagan-meeting' || fail "port $port/$protocol belongs to another project"; done
  fi
done
volume="$(docker volume inspect --format '{{ .Mountpoint }}' babagan-meeting_api-data 2>/dev/null || true)"
if (( bootstrap_empty )); then
  [[ -z "$volume" ]] || fail '--bootstrap-empty requires no pre-existing API database volume'
  [[ -z "$(compose ps -q)" ]] || fail '--bootstrap-empty requires no running managed Compose stack'
else
  [[ -n "$volume" && -f "$volume/meetings.sqlite" ]] || fail 'a verified baseline API database is required before deployment'
fi
[[ ! -e "$state_dir/pending-release.env" ]] || fail 'a previous deployment is pending recovery; run guarded rollback or archive its evidence before another deploy'
# All preflights above are read-only. The first mutation is a checksummed backup.
umask 077; mkdir -p "$state_dir/releases" "$backup_dir"; chmod 700 "$state_dir" "$state_dir/releases" "$backup_dir"
backup=''; backup_checksum=''
if (( ! bootstrap_empty )); then
  backup_output="$("$script_dir/backup.sh" "$volume/meetings.sqlite" "$backup_dir")"; backup="${backup_output#Backup created: }"
  [[ -f "$backup" && -f "$backup.sha256" ]] || fail 'backup did not create database and checksum'
  backup_checksum="$(awk '{print $1}' "$backup.sha256")"
fi
# Persist a protected transaction record before pull/build/migration. On any
# later failure it is the sole guarded recovery source, even though current-release still names the predecessor.
pending="$state_dir/pending-release.env"
pending_tmp="$pending.$$.tmp"
ssh_policy=restricted; (( allow_public_ssh )) && ssh_policy=public-operator-waiver
{
  if (( bootstrap_empty )); then printf 'RECORD_STATE=bootstrap-pending\nBOOTSTRAP_EMPTY=1\n'; else printf 'RECORD_STATE=pending\n'; fi
  printf 'CANDIDATE_SHA=%s\n' "$sha"
  printf 'SSH_POLICY=%s\n' "$ssh_policy"
  printf 'STARTED_AT_UTC=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if (( ! bootstrap_empty )); then
    printf 'DATABASE_BACKUP=%s\n' "$backup"; printf 'DATABASE_BACKUP_SHA256=%s\n' "$backup_checksum"; printf 'PREVIOUS_RELEASE_SHA=%s\n' "$previous_sha"
    printf 'PREVIOUS_API_IMAGE_TAG=%s\n' "$previous_api"; printf 'PREVIOUS_API_IMAGE_ID=%s\n' "$previous_api_id"; printf 'PREVIOUS_WEB_IMAGE_TAG=%s\n' "$previous_web"; printf 'PREVIOUS_WEB_IMAGE_ID=%s\n' "$previous_web_id"; printf 'PREVIOUS_CADDY_IMAGE_TAG=%s\n' "$previous_caddy"; printf 'PREVIOUS_CADDY_IMAGE_ID=%s\n' "$previous_caddy_id"; printf 'PREVIOUS_LIVEKIT_IMAGE_TAG=%s\n' "$previous_livekit"; printf 'PREVIOUS_LIVEKIT_IMAGE_ID=%s\n' "$previous_livekit_id"
  fi
} >"$pending_tmp"
chmod 600 "$pending_tmp"; mv "$pending_tmp" "$pending"
compose pull --policy missing caddy livekit coturn; compose build --pull api web
# One-shot migration: no listening service is started by this command.
compose run --rm --no-deps api node --input-type=module -e 'import {createDatabase} from "./dist/db/database.js"; import {migrate} from "./dist/db/migrate.js"; const db=createDatabase(process.env.DATABASE_PATH); try { migrate(db); } finally { db.close(); }'
if (( bootstrap_empty )); then
  bootstrap_volume_name='babagan-meeting_api-data'
  bootstrap_mountpoint="$(docker volume inspect --format '{{ .Mountpoint }}' "$bootstrap_volume_name" 2>/dev/null || true)"
  bootstrap_project="$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$bootstrap_volume_name" 2>/dev/null || true)"
  [[ -n "$bootstrap_mountpoint" && "$bootstrap_project" == babagan-meeting ]] || fail 'bootstrap candidate volume lacks expected Compose ownership label'
  bootstrap_marker_id="$(printf '%s' "$sha-$(date -u +%s)-$RANDOM" | sha256sum | awk '{print $1}')"
  bootstrap_marker="$bootstrap_mountpoint/.babagan-bootstrap-$bootstrap_marker_id"
  printf 'CANDIDATE_SHA=%s\nMARKER_ID=%s\n' "$sha" "$bootstrap_marker_id" >"$bootstrap_marker"
  chmod 600 "$bootstrap_marker"
  pending_resource_tmp="$pending.$$.resource"
  { cat "$pending"; printf 'BOOTSTRAP_VOLUME_NAME=%s\nBOOTSTRAP_VOLUME_MOUNTPOINT=%s\nBOOTSTRAP_VOLUME_PROJECT=%s\nBOOTSTRAP_VOLUME_MARKER_ID=%s\n' "$bootstrap_volume_name" "$bootstrap_mountpoint" "$bootstrap_project" "$bootstrap_marker_id"; } >"$pending_resource_tmp"
  chmod 600 "$pending_resource_tmp"; mv "$pending_resource_tmp" "$pending"
fi
image_id() {
  # `docker compose images` only lists containers that already exist.  During a
  # first deployment the one-shot migration container has been removed, so
  # resolve the configured image reference and inspect Docker's image store
  # directly instead. This intentionally uses only POSIX host tooling so the
  # deployment host does not need a separate Node.js installation.
  case "$1" in
    api|web)
      # Compose assigns this deterministic project/service tag to build-only
      # services, which intentionally have no `image:` entry in the config.
      image_ref="babagan-meeting-$1:latest"
      ;;
    *)
      image_ref="$(compose config | awk -v service="$1" '
        $0 ~ "^  " service ":$" { in_service = 1; next }
        in_service && $0 ~ "^  [A-Za-z0-9_-]+:$" { exit }
        in_service && $1 == "image:" { print $2; exit }
      ')"
      ;;
  esac
  [[ -n "$image_ref" ]] || return 1
  docker image inspect --format '{{.Id}}' "$image_ref"
}
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
  for service in caddy api livekit web coturn; do id="$(compose ps -q "$service")"; status="${id:+$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")}"; [[ "$status" == healthy ]] || healthy=0; done
  ((healthy)) && break; sleep 3
done
((healthy)) || { compose ps >&2; fail 'health wait exceeded 180 seconds'; }
token="$(<"$token_file")"; [[ -n "$token" ]] || fail 'smoke token is empty'
SMOKE_LIVEKIT_TOKEN="$token" "$script_dir/deployment-smoke.sh" \
  "$compose_file" "$env_file" "babagan-meeting-api:release-$sha" \
  https://meet.babagan.cloud wss://meet.babagan.cloud/rtc
unset token
record="$state_dir/releases/$sha.env"
{
 printf 'RELEASE_SHA=%s\n' "$sha"; printf 'DEPLOYED_AT_UTC=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; printf 'OVERRIDE_FILE=%s\n' "$override"; printf 'SSH_POLICY=%s\n' "$ssh_policy"
 if (( bootstrap_empty )); then printf 'BOOTSTRAP_EMPTY=1\n'; else printf 'DATABASE_BACKUP=%s\nDATABASE_BACKUP_SHA256=%s\n' "$backup" "$backup_checksum"; fi
 for service in api web caddy livekit; do upper="$(tr '[:lower:]' '[:upper:]' <<<"$service")"; printf '%s_IMAGE_TAG=%s\n' "$upper" "babagan-meeting-$service:release-$sha"; printf '%s_IMAGE_ID=%s\n' "$upper" "$(image_id "$service")"; done
 if (( ! bootstrap_empty )); then printf 'PREVIOUS_RELEASE_SHA=%s\n' "$previous_sha"; printf 'PREVIOUS_API_IMAGE_TAG=%s\n' "$previous_api"; printf 'PREVIOUS_API_IMAGE_ID=%s\n' "$previous_api_id"; printf 'PREVIOUS_WEB_IMAGE_TAG=%s\n' "$previous_web"; printf 'PREVIOUS_WEB_IMAGE_ID=%s\n' "$previous_web_id"; printf 'PREVIOUS_CADDY_IMAGE_TAG=%s\n' "$previous_caddy"; printf 'PREVIOUS_CADDY_IMAGE_ID=%s\n' "$previous_caddy_id"; printf 'PREVIOUS_LIVEKIT_IMAGE_TAG=%s\n' "$previous_livekit"; printf 'PREVIOUS_LIVEKIT_IMAGE_ID=%s\n' "$previous_livekit_id"; fi
} >"$record"
chmod 600 "$record"; cp "$record" "$previous"; chmod 600 "$previous"; mv "$pending" "$state_dir/releases/$sha.pending-completed.env"; chmod 600 "$state_dir/releases/$sha.pending-completed.env"
echo "DEPLOY SUCCEEDED: $sha"; echo "Release record: $record"; echo "Backup: $backup"
