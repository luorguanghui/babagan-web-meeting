#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin"

cat >"$temp_dir/bin/getent" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat >"$temp_dir/bin/node" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat >"$temp_dir/bin/timeout" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

cat >"$temp_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
args="$*"
case "$args" in
  */health/live*) printf '%s\n' '{"status":"ok"}' ;;
  */health/ready*) printf '%s\n' '{"status":"ready"}' ;;
  */api/v1/meetings/*/ice-servers*turnProvider=cloudflare*)
    cat <<'JSON'
HTTP/1.1 200 OK
cache-control: no-store

{"iceServers":[{"urls":["stun:stun.cloudflare.com:3478"]},{"urls":["turn:turn.cloudflare.com:3478?transport=udp"],"username":"opaque-user","credential":"c21va2U="}],"turnProvider":"cloudflare","turnCredentialsExpiresAt":9999999999}
JSON
    ;;
  */api/v1/meetings/*/p2p*) printf '403' ;;
  */) printf '%s\n' '<div id="root"></div>' ;;
  *) echo "unexpected curl request: $args" >&2; exit 1 ;;
esac
EOF
chmod 700 "$temp_dir/bin"/*

PATH="$temp_dir/bin:$PATH" \
SMOKE_LIVEKIT_TOKEN=fresh.header.signature \
SMOKE_MEETING_SLUG=abcdefghijklmnopqrstuvwx \
SMOKE_PARTICIPANT_COOKIE=wm_participant=signed%2Fcookie.value \
P2P_STUN_URLS=stun:stun.example.com:3478 \
P2P_TURN_URLS=turn:turn.example.com:3478 \
P2P_TURN_PROVIDER=cloudflare \
SMOKE_REQUESTED_TURN_PROVIDER=cloudflare \
SMOKE_NODE_IMAGE=meeting-api:test \
  bash "$root/scripts/smoke-test.sh" https://meet.example.com wss://rtc.example.com

echo 'Cloudflare provider smoke regression passed'
