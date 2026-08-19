#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=firewall-attestation.sh
source "$root/scripts/firewall-attestation.sh"

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

restricted="$temp_dir/restricted.txt"
cat >"$restricted" <<'EOF'
Alibaba inbound: TCP 80,443,3478,5349,7881; UDP 443,3478,49160-49200,50000-60000; SSH restricted
Host firewall: TCP 80,443,3478,5349,7881; UDP 443,3478,49160-49200,50000-60000; SSH restricted; default deny inbound
EOF

public="$temp_dir/public.txt"
cat >"$public" <<'EOF'
Alibaba inbound: TCP 80,443,3478,5349,7881; UDP 443,3478,49160-49200,50000-60000; SSH public by operator decision
Host firewall: TCP 80,443,3478,5349,7881; UDP 443,3478,49160-49200,50000-60000; SSH public by operator decision; default deny inbound
EOF

verify_firewall_attestation "$restricted" 0

if verify_firewall_attestation "$public" 0; then
  echo 'public SSH evidence was accepted without an explicit waiver' >&2
  exit 1
fi

warning="$(verify_firewall_attestation "$public" 1 2>&1)"
[[ "$warning" == *'WARNING: public SSH exposure explicitly accepted by operator'* ]] || {
  echo 'public SSH waiver did not emit an audit warning' >&2
  exit 1
}

if verify_firewall_attestation "$restricted" 1; then
  echo 'public SSH waiver incorrectly accepted restricted evidence' >&2
  exit 1
fi

printf 'Firewall attestation tests passed.\n'
