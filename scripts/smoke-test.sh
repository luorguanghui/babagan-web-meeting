#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: SMOKE_LIVEKIT_TOKEN=token [SMOKE_CORE_ONLY=1 | SMOKE_MEETING_SLUG=slug SMOKE_PARTICIPANT_COOKIE='name=value' P2P_TURN_PROVIDER=coturn|cloudflare SMOKE_REQUESTED_TURN_PROVIDER=auto|coturn|cloudflare P2P_STUN_URLS=stun:host:3478 P2P_TURN_URLS=turn:host:3478] $0 https://meet.example.com wss://rtc.example.com" >&2
  exit 64
}

[[ $# -eq 2 ]] || usage
public_base=${1%/}
rtc_url=$2
script_directory=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=http-headers.sh
source "$script_directory/http-headers.sh"
[[ "$public_base" =~ ^https:// ]] || { echo 'The public URL must use HTTPS.' >&2; exit 64; }
[[ "$rtc_url" =~ ^wss:// ]] || { echo 'The RTC URL must use WSS.' >&2; exit 64; }
[[ -n ${SMOKE_LIVEKIT_TOKEN:-} ]] || { echo 'SMOKE_LIVEKIT_TOKEN is required to verify an authenticated WebSocket upgrade.' >&2; exit 64; }
core_only=${SMOKE_CORE_ONLY:-0}
[[ "$core_only" == 0 || "$core_only" == 1 ]] || { echo 'SMOKE_CORE_ONLY must be 0 or 1.' >&2; exit 64; }
turn_provider=${P2P_TURN_PROVIDER:-coturn}
[[ "$turn_provider" == coturn || "$turn_provider" == cloudflare ]] || { echo 'P2P_TURN_PROVIDER must be coturn or cloudflare.' >&2; exit 64; }
requested_turn_provider=${SMOKE_REQUESTED_TURN_PROVIDER:-auto}
[[ "$requested_turn_provider" == auto || "$requested_turn_provider" == coturn || "$requested_turn_provider" == cloudflare ]] \
  || { echo 'SMOKE_REQUESTED_TURN_PROVIDER must be auto, coturn, or cloudflare.' >&2; exit 64; }
if [[ "$core_only" == 0 ]]; then
  [[ -n ${SMOKE_MEETING_SLUG:-} ]] || { echo 'SMOKE_MEETING_SLUG is required to verify P2P endpoints.' >&2; exit 64; }
  [[ -n ${SMOKE_PARTICIPANT_COOKIE:-} ]] || { echo 'SMOKE_PARTICIPANT_COOKIE is required to verify authenticated P2P endpoints.' >&2; exit 64; }
  [[ -n ${P2P_STUN_URLS:-} ]] || { echo 'P2P_STUN_URLS is required to verify the deployed STUN configuration.' >&2; exit 64; }
  [[ -n ${P2P_TURN_URLS:-} ]] || { echo 'P2P_TURN_URLS is required to verify the deployed TURN configuration.' >&2; exit 64; }
fi

fail() { echo "SMOKE FAILED: $1" >&2; exit 1; }
require() { command -v "$1" >/dev/null || fail "required command is missing: $1"; }
require curl
require getent
require grep
require timeout

public_host=${public_base#https://}
public_host=${public_host%%/*}
rtc_host=${rtc_url#wss://}
rtc_host=${rtc_host%%/*}
getent ahostsv4 "$public_host" >/dev/null || fail "DNS does not resolve $public_host"
getent ahostsv4 "$rtc_host" >/dev/null || fail "DNS does not resolve $rtc_host"

curl --fail --silent --show-error --proto '=https' --tlsv1.2 "$public_base/health/live" | grep -qx '{"status":"ok"}' || fail 'live health check failed'
curl --fail --silent --show-error --proto '=https' --tlsv1.2 "$public_base/health/ready" | grep -qx '{"status":"ready"}' || fail 'ready health check failed'
curl --fail --silent --show-error --proto '=https' --tlsv1.2 "$public_base/" | grep -q 'id="root"' || fail 'SPA did not load'

if [[ "$core_only" == 0 ]]; then
  ice_request_url="$public_base/api/v1/meetings/$SMOKE_MEETING_SLUG/ice-servers"
  if [[ "$requested_turn_provider" != auto ]]; then
    ice_request_url+="?turnProvider=$requested_turn_provider"
  fi
  ice_response=$(curl --dump-header - --fail --silent --show-error --proto '=https' --tlsv1.2 \
    -H "Origin: $public_base" \
    -H "Cookie: $SMOKE_PARTICIPANT_COOKIE" \
    "$ice_request_url") \
    || fail 'authenticated ICE configuration request failed'
  ice_response="$(normalize_http_response "$ice_response")"
  active_turn_provider=$turn_provider
  [[ "$requested_turn_provider" == auto ]] || active_turn_provider=$requested_turn_provider
  if [[ "$active_turn_provider" == cloudflare ]]; then
    grep -Eq '"turnProvider"[[:space:]]*:[[:space:]]*"cloudflare"' <<<"$ice_response" \
      || fail 'authenticated ICE response does not report Cloudflare as the active TURN provider'
    grep -Eq '"stun:stun\.cloudflare\.com:3478"' <<<"$ice_response" \
      || fail 'authenticated Cloudflare ICE response does not contain the Cloudflare STUN URL'
    grep -Eq '"turn:turn\.cloudflare\.com:3478\?transport=udp"' <<<"$ice_response" \
      || fail 'authenticated Cloudflare ICE response does not contain the Cloudflare TURN URL'
  else
    grep -Eq '"turnProvider"[[:space:]]*:[[:space:]]*"coturn"' <<<"$ice_response" \
      || fail 'authenticated ICE response does not report coturn as the active TURN provider'
    expected_stun=${P2P_STUN_URLS%%,*}
    expected_turn=${P2P_TURN_URLS%%,*}
    grep -Fq "\"$expected_stun\"" <<<"$ice_response" \
      || fail 'authenticated ICE response does not contain the configured STUN URL'
    grep -Fq "\"$expected_turn\"" <<<"$ice_response" \
      || fail 'authenticated ICE response does not contain the configured TURN URL'
  fi
  if [[ "$active_turn_provider" == cloudflare ]]; then
    grep -Eq '"username":"[^":]+"' <<<"$ice_response" \
      || fail 'authenticated Cloudflare ICE response does not contain a TURN username'
  else
    grep -Eq '"username":"[0-9]+:[^"]+"' <<<"$ice_response" \
      || fail 'authenticated ICE response does not contain an expiring TURN username'
  fi
  grep -Eq '"credential":"[A-Za-z0-9+/]+=*"' <<<"$ice_response" \
    || fail 'authenticated ICE response does not contain a TURN credential'
  grep -Eiq '^cache-control:[[:space:]]*no-store[[:space:]]*$' <<<"$ice_response" \
    || fail 'authenticated ICE response is missing Cache-Control: no-store'

  cross_site_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --proto '=https' --tlsv1.2 --http1.1 \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: c21va2Utd2Vic29ja2V0LWtleQ==' \
    -H 'Origin: https://evil.example' \
    -H "Cookie: $SMOKE_PARTICIPANT_COOKIE" \
    "$public_base/api/v1/meetings/$SMOKE_MEETING_SLUG/p2p")
  [[ "$cross_site_status" == 403 ]] || fail "cross-site P2P WebSocket Origin returned HTTP $cross_site_status instead of 403"
fi

if command -v node >/dev/null; then
  websocket_probe() {
    node "$script_directory/verify-websocket.mjs" "$rtc_url"
  }
elif command -v docker >/dev/null && [[ -n ${SMOKE_NODE_IMAGE:-} ]]; then
  websocket_probe() {
    docker run --rm --network host \
      -v "$script_directory:/scripts:ro" \
      -e SMOKE_LIVEKIT_TOKEN \
      --entrypoint node "$SMOKE_NODE_IMAGE" \
      /scripts/verify-websocket.mjs "$rtc_url"
  }
else
  fail 'required command is missing: node (or set SMOKE_NODE_IMAGE with Docker available)'
fi
websocket_ok=0
for websocket_attempt in 1 2 3; do
  if websocket_probe; then websocket_ok=1; break; fi
  (( websocket_attempt < 3 )) && sleep 5
done
(( websocket_ok )) || fail 'RTC endpoint did not complete a bounded authenticated WebSocket open'

for blocked_port in 3000 7880; do
  if timeout 3 bash -c ">/dev/tcp/$rtc_host/$blocked_port" 2>/dev/null; then
    fail "forbidden public TCP port is reachable: $rtc_host:$blocked_port"
  fi
done

echo "SMOKE PASSED: $public_base and $rtc_url"
