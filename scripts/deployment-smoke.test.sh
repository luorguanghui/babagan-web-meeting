#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin" "$temp_dir/scripts"
cp "$root/scripts/deployment-smoke.sh" "$temp_dir/scripts/deployment-smoke.sh"

cat >"$temp_dir/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$MOCK_DOCKER_LOG"
case "$*" in
  *'deployment-smoke-session-cli.js create'*)
    printf '%s\n' 'SMOKE_MEETING_SLUG=abcdefghijklmnopqrstuvwx'
    printf '%s\n' 'SMOKE_PARTICIPANT_COOKIE=wm_participant=signed%2Fcookie.value'
    printf '%s\n' 'SMOKE_LIVEKIT_TOKEN=fresh.header.signature'
    ;;
  *'deployment-smoke-session-cli.js delete abcdefghijklmnopqrstuvwx'*) ;;
  *'cloudflare-sfu-check-cli.js'*) [[ ${MOCK_SFU_SHOULD_FAIL:-0} != 1 ]] ;;
  *) exit 90 ;;
esac
EOF
chmod 700 "$temp_dir/bin/docker"
cat >"$temp_dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"available":true,"publication":null}'
EOF
chmod 700 "$temp_dir/bin/curl"

cat >"$temp_dir/scripts/smoke-test.sh" <<'EOF'
#!/usr/bin/env bash
{
  printf 'slug=%s\n' "$SMOKE_MEETING_SLUG"
  printf 'cookie=%s\n' "$SMOKE_PARTICIPANT_COOKIE"
  printf 'provider=%s\n' "$P2P_TURN_PROVIDER"
  printf 'requested=%s\n' "${SMOKE_REQUESTED_TURN_PROVIDER:-}"
  printf 'stun=%s\n' "$P2P_STUN_URLS"
  printf 'turn=%s\n' "$P2P_TURN_URLS"
  printf 'image=%s\n' "$SMOKE_NODE_IMAGE"
  printf 'livekit_token=%s\n' "$SMOKE_LIVEKIT_TOKEN"
  printf 'args=%s|%s\n' "$1" "$2"
} >>"$MOCK_SMOKE_LOG"
[[ ${SMOKE_SHOULD_FAIL:-0} != 1 ]]
EOF
chmod 700 "$temp_dir/scripts/smoke-test.sh"

printf '%s\n' \
  'P2P_TURN_PROVIDER=coturn' \
  'P2P_STUN_URLS=stun:stun.example.com:3478' \
  'P2P_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp' \
  'P2P_TURN_SECRET=0123456789abcdef0123456789abcdef' \
  'P2P_TURN_TTL_SECONDS=600' \
  'TURN_SHARED_SECRET=0123456789abcdef0123456789abcdef' \
  'CLOUDFLARE_SFU_APP_ID=app-id' \
  'CLOUDFLARE_SFU_APP_SECRET=app-secret' >"$temp_dir/production.env"
chmod 600 "$temp_dir/production.env"
printf '%s\n' 'services: {}' >"$temp_dir/docker-compose.yml"

run_smoke() {
  PATH="$temp_dir/bin:$PATH" \
    SMOKE_LIVEKIT_TOKEN=stale-livekit-token \
    MOCK_DOCKER_LOG="$temp_dir/docker.log" \
    MOCK_SMOKE_LOG="$temp_dir/smoke.log" \
    bash "$temp_dir/scripts/deployment-smoke.sh" \
      "$temp_dir/docker-compose.yml" "$temp_dir/production.env" meeting-api:test \
      https://meet.example.com wss://rtc.example.com
}

output="$(run_smoke)"
[[ "$output" != *'signed%2Fcookie.value'* ]] || { echo 'smoke cookie leaked to stdout' >&2; exit 1; }
[[ "$output" != *'app-secret'* ]] || { echo 'SFU app secret leaked to stdout' >&2; exit 1; }
grep -Fq 'CLOUDFLARE_SFU_API_OK' <<<"$output"
grep -Fq 'cloudflare-sfu-check-cli.js' "$temp_dir/docker.log"
grep -Fq 'deployment-smoke-session-cli.js create' "$temp_dir/docker.log"
grep -Fq -- '-e DATABASE_PATH=/data/meetings.sqlite' "$temp_dir/docker.log"
grep -Fq 'deployment-smoke-session-cli.js delete abcdefghijklmnopqrstuvwx' "$temp_dir/docker.log"
grep -Fqx 'slug=abcdefghijklmnopqrstuvwx' "$temp_dir/smoke.log"
grep -Fqx 'cookie=wm_participant=signed%2Fcookie.value' "$temp_dir/smoke.log"
grep -Fqx 'provider=coturn' "$temp_dir/smoke.log"
grep -Fqx 'requested=coturn' "$temp_dir/smoke.log"
grep -Fqx 'stun=stun:stun.example.com:3478' "$temp_dir/smoke.log"
grep -Fqx 'turn=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp' "$temp_dir/smoke.log"
grep -Fqx 'image=meeting-api:test' "$temp_dir/smoke.log"
grep -Fqx 'livekit_token=fresh.header.signature' "$temp_dir/smoke.log" \
  || { echo 'deployment smoke reused a stale static LiveKit token' >&2; exit 1; }
grep -Fc 'args=https://meet.example.com|wss://rtc.example.com' "$temp_dir/smoke.log" | grep -Fxq '1' \
  || { echo 'deployment smoke wrapper did not run the coturn check' >&2; exit 1; }

: >"$temp_dir/docker.log"
: >"$temp_dir/smoke.log"
if MOCK_SFU_SHOULD_FAIL=1 run_smoke; then
  echo 'configured SFU failure did not block the deployment smoke' >&2
  exit 1
fi
grep -Fq 'deployment-smoke-session-cli.js delete abcdefghijklmnopqrstuvwx' "$temp_dir/docker.log" \
  || { echo 'failed SFU smoke did not clean its disposable meeting' >&2; exit 1; }
: >"$temp_dir/docker.log"
: >"$temp_dir/smoke.log"
if SMOKE_SHOULD_FAIL=1 run_smoke; then
  echo 'deployment smoke wrapper ignored smoke-test failure' >&2
  exit 1
fi
grep -Fq 'deployment-smoke-session-cli.js delete abcdefghijklmnopqrstuvwx' "$temp_dir/docker.log" \
  || { echo 'failed smoke did not clean its disposable meeting' >&2; exit 1; }

echo 'deployment authenticated smoke regression checks passed'
