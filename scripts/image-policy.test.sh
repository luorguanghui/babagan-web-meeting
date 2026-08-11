#!/usr/bin/env bash
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=image-policy.sh
source "$script_dir/image-policy.sh"

assert_minimum_image_version 'livekit/livekit-server:v1.11.0' 1.11.0
assert_minimum_image_version 'registry.example/livekit/livekit-server:v1.11.0@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 1.11.0
assert_minimum_image_version 'registry.example/livekit/livekit-server:v1.12.3' 1.11.0
assert_minimum_image_version 'registry.example:5000/livekit/livekit-server:2.0.0' 1.11.0

for rejected in \
  'livekit/livekit-server:v1.10.99' \
  'livekit/livekit-server:latest' \
  'livekit/livekit-server:v1.11' \
  'livekit/livekit-server:v1.11.0 extra'; do
  if assert_minimum_image_version "$rejected" 1.11.0; then
    echo "image policy incorrectly accepted: $rejected" >&2
    exit 1
  fi
done

echo 'image version policy checks passed'
