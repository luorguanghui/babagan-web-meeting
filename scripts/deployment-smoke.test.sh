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
    ;;
  *'deployment-smoke-session-cli.js delete abcdefghijklmnopqrstuvwx'*) ;;
  *) exit 90 ;;
esac
EOF
chmod 700 "$temp_dir/bin/docker"

cat >"$temp_dir/scripts/smoke-test.sh" <<'EOF'
#!/usr/bin/env bash
{
  printf 'slug=%s\n' "$SMOKE_MEETING_SLUG"
  printf 'cookie=%s\n' "$SMOKE_PARTICIPANT_COOKIE"
  printf 'stun=%s\n' "$P2P_STUN_URLS"
  printf 'image=%s\n' "$SMOKE_NODE_IMAGE"
  printf 'args=%s|%s\n' "$1" "$2"
} >>"$MOCK_SMOKE_LOG"
[[ ${SMOKE_SHOULD_FAIL:-0} != 1 ]]
EOF
chmod 700 "$temp_dir/scripts/smoke-test.sh"

printf '%s\n' 'P2P_STUN_URLS=stun:stun.cloudflare.com:3478' >"$temp_dir/production.env"
chmod 600 "$temp_dir/production.env"
printf '%s\n' 'services: {}' >"$temp_dir/docker-compose.yml"

run_smoke() {
  PATH="$temp_dir/bin:$PATH" \
    MOCK_DOCKER_LOG="$temp_dir/docker.log" \
    MOCK_SMOKE_LOG="$temp_dir/smoke.log" \
    bash "$temp_dir/scripts/deployment-smoke.sh" \
      "$temp_dir/docker-compose.yml" "$temp_dir/production.env" meeting-api:test \
      https://meet.example.com wss://rtc.example.com
}

output="$(run_smoke)"
[[ "$output" != *'signed%2Fcookie.value'* ]] || { echo 'smoke cookie leaked to stdout' >&2; exit 1; }
grep -Fq 'deployment-smoke-session-cli.js create' "$temp_dir/docker.log"
grep -Fq 'deployment-smoke-session-cli.js delete abcdefghijklmnopqrstuvwx' "$temp_dir/docker.log"
grep -Fqx 'slug=abcdefghijklmnopqrstuvwx' "$temp_dir/smoke.log"
grep -Fqx 'cookie=wm_participant=signed%2Fcookie.value' "$temp_dir/smoke.log"
grep -Fqx 'stun=stun:stun.cloudflare.com:3478' "$temp_dir/smoke.log"
grep -Fqx 'image=meeting-api:test' "$temp_dir/smoke.log"

: >"$temp_dir/docker.log"
: >"$temp_dir/smoke.log"
if SMOKE_SHOULD_FAIL=1 run_smoke; then
  echo 'deployment smoke wrapper ignored smoke-test failure' >&2
  exit 1
fi
grep -Fq 'deployment-smoke-session-cli.js delete abcdefghijklmnopqrstuvwx' "$temp_dir/docker.log" \
  || { echo 'failed smoke did not clean its disposable meeting' >&2; exit 1; }

echo 'deployment authenticated smoke regression checks passed'
