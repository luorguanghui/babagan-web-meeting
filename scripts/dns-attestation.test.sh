#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/scripts/firewall-attestation.sh"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
printf '%s\n' 'Cloudflare: meet DNS-only; rtc DNS-only; turn DNS-only' >"$temp_dir/dns-only"
verify_dns_attestation "$temp_dir/dns-only"
printf '%s\n' 'Cloudflare: meet proxied; rtc DNS-only; turn DNS-only; SSL/TLS Full (strict)' >"$temp_dir/proxied"
if verify_dns_attestation "$temp_dir/proxied"; then echo 'legacy proxied topology was accepted' >&2; exit 1; fi
printf '%s\n' 'Cloudflare: meet DNS-only; rtc DNS-only' >"$temp_dir/incomplete"
if verify_dns_attestation "$temp_dir/incomplete"; then echo 'incomplete topology was accepted' >&2; exit 1; fi
echo 'DNS-only attestation regression passed'
