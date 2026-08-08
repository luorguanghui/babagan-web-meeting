#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: SMOKE_LIVEKIT_TOKEN=token $0 https://meet.example.com wss://rtc.example.com" >&2
  exit 64
}

[[ $# -eq 2 ]] || usage
public_base=${1%/}
rtc_url=$2
[[ "$public_base" =~ ^https:// ]] || { echo 'The public URL must use HTTPS.' >&2; exit 64; }
[[ "$rtc_url" =~ ^wss:// ]] || { echo 'The RTC URL must use WSS.' >&2; exit 64; }
[[ -n ${SMOKE_LIVEKIT_TOKEN:-} ]] || { echo 'SMOKE_LIVEKIT_TOKEN is required to verify an authenticated WebSocket upgrade.' >&2; exit 64; }

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

script_directory=$(cd "$(dirname "$0")" && pwd -P)
if command -v node >/dev/null; then
  node "$script_directory/verify-websocket.mjs" "$rtc_url" || fail 'RTC endpoint did not complete a bounded authenticated WebSocket open'
elif command -v docker >/dev/null && [[ -n ${SMOKE_NODE_IMAGE:-} ]]; then
  docker run --rm --network host \
    -v "$script_directory:/scripts:ro" \
    -e SMOKE_LIVEKIT_TOKEN \
    --entrypoint node "$SMOKE_NODE_IMAGE" \
    /scripts/verify-websocket.mjs "$rtc_url" || fail 'RTC endpoint did not complete a bounded authenticated WebSocket open'
else
  fail 'required command is missing: node (or set SMOKE_NODE_IMAGE with Docker available)'
fi

for blocked_port in 3000 7880; do
  if timeout 3 bash -c ">/dev/tcp/$rtc_host/$blocked_port" 2>/dev/null; then
    fail "forbidden public TCP port is reachable: $rtc_host:$blocked_port"
  fi
done

echo "SMOKE PASSED: $public_base and $rtc_url"
