#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "Usage: $0 COMPOSE_FILE ENV_FILE API_IMAGE PUBLIC_BASE RTC_URL" >&2
  exit 64
}

[[ $# -eq 5 ]] || usage
compose_file=$1
env_file=$2
api_image=$3
public_base=$4
rtc_url=$5
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

[[ -s "$compose_file" ]] || { echo 'deployment smoke compose file is missing' >&2; exit 1; }
[[ -s "$env_file" ]] || { echo 'deployment smoke environment file is missing' >&2; exit 1; }
[[ "$(grep -c '^P2P_STUN_URLS=' "$env_file")" == 1 ]] \
  || { echo 'production environment must contain exactly one P2P_STUN_URLS entry' >&2; exit 1; }
p2p_stun_urls="$(sed -n 's/^P2P_STUN_URLS=//p' "$env_file")"
[[ "$p2p_stun_urls" == stun:* || "$p2p_stun_urls" == stuns:* ]] \
  || { echo 'production P2P_STUN_URLS is invalid' >&2; exit 1; }
for key in P2P_TURN_URLS P2P_TURN_SECRET P2P_TURN_TTL_SECONDS TURN_SHARED_SECRET; do
  [[ "$(grep -c "^${key}=" "$env_file")" == 1 ]] \
    || { echo "production environment must contain exactly one $key entry" >&2; exit 1; }
done
p2p_turn_urls="$(sed -n 's/^P2P_TURN_URLS=//p' "$env_file")"
p2p_turn_secret="$(sed -n 's/^P2P_TURN_SECRET=//p' "$env_file")"
turn_shared_secret="$(sed -n 's/^TURN_SHARED_SECRET=//p' "$env_file")"
turn_ttl="$(sed -n 's/^P2P_TURN_TTL_SECONDS=//p' "$env_file")"
turn_provider="$(sed -n 's/^P2P_TURN_PROVIDER=//p' "$env_file")"; turn_provider="${turn_provider:-coturn}"
[[ "$turn_provider" == coturn || "$turn_provider" == cloudflare ]] \
  || { echo 'production P2P_TURN_PROVIDER is invalid' >&2; exit 1; }
[[ "$p2p_turn_urls" == turn:* || "$p2p_turn_urls" == turns:* ]] \
  || { echo 'production P2P_TURN_URLS is invalid' >&2; exit 1; }
[[ ${#p2p_turn_secret} -ge 32 && "$p2p_turn_secret" == "$turn_shared_secret" ]] \
  || { echo 'API and coturn secrets must match and contain at least 32 characters' >&2; exit 1; }
[[ "$turn_ttl" == 600 ]] || { echo 'production TURN credential TTL must be 600 seconds' >&2; exit 1; }

probe_output="$(docker run --rm --network none --env-file "$env_file" \
  -e DATABASE_PATH=/data/meetings.sqlite \
  -v babagan-meeting_api-data:/data --entrypoint node "$api_image" \
  dist/smoke/deployment-smoke-session-cli.js create)"
[[ "$(grep -c '^SMOKE_MEETING_SLUG=' <<<"$probe_output")" == 1 ]] \
  || { echo 'deployment smoke session did not return one slug' >&2; exit 1; }
[[ "$(grep -c '^SMOKE_PARTICIPANT_COOKIE=' <<<"$probe_output")" == 1 ]] \
  || { echo 'deployment smoke session did not return one cookie' >&2; exit 1; }
[[ "$(grep -c '^SMOKE_LIVEKIT_TOKEN=' <<<"$probe_output")" == 1 ]] \
  || { echo 'deployment smoke session did not return one LiveKit token' >&2; exit 1; }
smoke_slug="$(sed -n 's/^SMOKE_MEETING_SLUG=//p' <<<"$probe_output")"
smoke_cookie="$(sed -n 's/^SMOKE_PARTICIPANT_COOKIE=//p' <<<"$probe_output")"
smoke_livekit_token="$(sed -n 's/^SMOKE_LIVEKIT_TOKEN=//p' <<<"$probe_output")"
[[ "$smoke_slug" =~ ^[A-Za-z0-9_-]+$ && ${#smoke_slug} -ge 22 && ${#smoke_slug} -le 256 ]] \
  || { echo 'deployment smoke session returned an invalid slug' >&2; exit 1; }
[[ "$smoke_cookie" =~ ^wm_participant=[A-Za-z0-9._~%+-]+$ ]] \
  || { echo 'deployment smoke session returned an invalid cookie' >&2; exit 1; }
[[ "$smoke_livekit_token" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] \
  || { echo 'deployment smoke session returned an invalid LiveKit token' >&2; exit 1; }
unset probe_output

cleanup_probe() {
  docker run --rm --network none --env-file "$env_file" \
    -e DATABASE_PATH=/data/meetings.sqlite \
    -v babagan-meeting_api-data:/data --entrypoint node "$api_image" \
    dist/smoke/deployment-smoke-session-cli.js delete "$smoke_slug" >/dev/null
}
cleanup_on_exit() {
  status=$?
  trap - EXIT
  cleanup_probe || status=1
  exit "$status"
}
trap cleanup_on_exit EXIT

cloudflare_credentials_present=0
if grep -Eq '^CLOUDFLARE_TURN_KEY_ID=.+$' "$env_file" && grep -Eq '^CLOUDFLARE_TURN_API_TOKEN=.+$' "$env_file"; then
  cloudflare_credentials_present=1
fi

SMOKE_MEETING_SLUG="$smoke_slug" \
SMOKE_PARTICIPANT_COOKIE="$smoke_cookie" \
SMOKE_LIVEKIT_TOKEN="$smoke_livekit_token" \
P2P_STUN_URLS="$p2p_stun_urls" \
P2P_TURN_URLS="$p2p_turn_urls" \
P2P_TURN_PROVIDER="$turn_provider" \
SMOKE_NODE_IMAGE="$api_image" \
  "$script_dir/smoke-test.sh" "$public_base" "$rtc_url"
if (( cloudflare_credentials_present )); then
  SMOKE_REQUESTED_TURN_PROVIDER=coturn \
  SMOKE_MEETING_SLUG="$smoke_slug" \
  SMOKE_PARTICIPANT_COOKIE="$smoke_cookie" \
  SMOKE_LIVEKIT_TOKEN="$smoke_livekit_token" \
  P2P_STUN_URLS="$p2p_stun_urls" \
  P2P_TURN_URLS="$p2p_turn_urls" \
  P2P_TURN_PROVIDER="$turn_provider" \
  SMOKE_NODE_IMAGE="$api_image" \
    "$script_dir/smoke-test.sh" "$public_base" "$rtc_url"
  SMOKE_REQUESTED_TURN_PROVIDER=cloudflare \
  SMOKE_MEETING_SLUG="$smoke_slug" \
  SMOKE_PARTICIPANT_COOKIE="$smoke_cookie" \
  SMOKE_LIVEKIT_TOKEN="$smoke_livekit_token" \
  P2P_STUN_URLS="$p2p_stun_urls" \
  P2P_TURN_URLS="$p2p_turn_urls" \
  P2P_TURN_PROVIDER="$turn_provider" \
  SMOKE_NODE_IMAGE="$api_image" \
    "$script_dir/smoke-test.sh" "$public_base" "$rtc_url"
fi

cleanup_probe
trap - EXIT
unset smoke_cookie
unset smoke_livekit_token
echo 'Authenticated deployment smoke session cleaned up'
