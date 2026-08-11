#!/usr/bin/env bash

verify_firewall_attestation() {
  local evidence_file=$1 allow_public_ssh=$2
  if (( allow_public_ssh )); then
    grep -Fqx 'Alibaba inbound: TCP 80,443,7881; UDP 443,50000-60000; SSH public by operator decision' "$evidence_file" || return 1
    grep -Fqx 'Host firewall: TCP 80,443,7881; UDP 443,50000-60000; SSH public by operator decision; default deny inbound' "$evidence_file" || return 1
    printf 'WARNING: public SSH exposure explicitly accepted by operator\n' >&2
    return 0
  fi

  grep -Fqx 'Alibaba inbound: TCP 80,443,7881; UDP 443,50000-60000; SSH restricted' "$evidence_file" || return 1
  grep -Fqx 'Host firewall: TCP 80,443,7881; UDP 443,50000-60000; SSH restricted; default deny inbound' "$evidence_file" || return 1
}
