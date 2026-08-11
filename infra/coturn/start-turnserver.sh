#!/bin/sh
set -eu

fail() {
  echo "coturn startup: $1" >&2
  exit 1
}

secret="${TURN_SHARED_SECRET:-}"
external_ip="${TURN_EXTERNAL_IP:-}"
relay_ip="${TURN_RELAY_IP:-}"
turnserver_bin="${TURN_SERVER_BIN:-turnserver}"
cert_path="${TURN_CERT_PATH:-/caddy-data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/turn.babagan.cloud/turn.babagan.cloud.crt}"
pkey_path="${TURN_PKEY_PATH:-/caddy-data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/turn.babagan.cloud/turn.babagan.cloud.key}"

[ "${#secret}" -ge 32 ] || fail 'TURN_SHARED_SECRET must be at least 32 characters'
[ -n "$external_ip" ] || fail 'TURN_EXTERNAL_IP is required'
[ -n "$relay_ip" ] || fail 'TURN_RELAY_IP is required'

attempt=0
while [ ! -s "$cert_path" ] || [ ! -s "$pkey_path" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -le 90 ] || fail 'Caddy TURN certificate was not ready within 180 seconds'
  sleep 2
done

exec "$turnserver_bin" \
  --config=/etc/coturn/turnserver.conf \
  "--static-auth-secret=$secret" \
  "--external-ip=$external_ip/$relay_ip" \
  "--relay-ip=$relay_ip" \
  "--cert=$cert_path" \
  "--pkey=$pkey_path"
