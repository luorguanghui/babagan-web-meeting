#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
script="$root/infra/coturn/start-turnserver.sh"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

printf '%s\n' certificate >"$temp_dir/cert.pem"
printf '%s\n' private-key >"$temp_dir/key.pem"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$@" >"$TURN_TEST_LOG"' >"$temp_dir/turnserver"
chmod +x "$temp_dir/turnserver"

if TURN_SERVER_BIN="$temp_dir/turnserver" TURN_CERT_PATH="$temp_dir/cert.pem" TURN_PKEY_PATH="$temp_dir/key.pem" \
  TURN_EXTERNAL_IP=203.0.113.10 TURN_RELAY_IP=10.0.0.8 TURN_TEST_LOG="$temp_dir/args" \
  sh "$script"; then
  echo 'startup incorrectly accepted a missing TURN_SHARED_SECRET' >&2
  exit 1
fi

TURN_SERVER_BIN="$temp_dir/turnserver" TURN_CERT_PATH="$temp_dir/cert.pem" TURN_PKEY_PATH="$temp_dir/key.pem" \
  TURN_SHARED_SECRET=0123456789abcdef0123456789abcdef TURN_EXTERNAL_IP=203.0.113.10 \
  TURN_RELAY_IP=10.0.0.8 TURN_TEST_LOG="$temp_dir/args" sh "$script"

grep -Fx -- '--config=/etc/coturn/turnserver.conf' "$temp_dir/args"
grep -Fx -- '--static-auth-secret=0123456789abcdef0123456789abcdef' "$temp_dir/args"
grep -Fx -- '--external-ip=203.0.113.10/10.0.0.8' "$temp_dir/args"
grep -Fx -- "--cert=$temp_dir/cert.pem" "$temp_dir/args"
grep -Fx -- "--pkey=$temp_dir/key.pem" "$temp_dir/args"

echo 'coturn startup validation checks passed'
