#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=http-headers.sh
source "$root/scripts/http-headers.sh"

response=$'HTTP/2 200\r\ncache-control: no-store\r\ncontent-type: application/json\r\n\r\n{}'
expected=$'HTTP/2 200\ncache-control: no-store\ncontent-type: application/json\n\n{}'
actual="$(normalize_http_response "$response")"

[[ "$actual" == "$expected" ]] || {
  echo 'HTTP response normalization did not remove CR bytes' >&2
  exit 1
}

echo 'HTTP response normalization regression check passed'
