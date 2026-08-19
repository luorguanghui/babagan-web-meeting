#!/usr/bin/env bash

assert_minimum_image_version() {
  local image_ref="$1" minimum="$2" image_without_digest version
  local major minor patch minimum_major minimum_minor minimum_patch

  [[ "$image_ref" != *[[:space:]]* ]] || return 1
  image_without_digest="${image_ref%%@*}"
  version="${image_without_digest##*:}"
  version="${version#v}"
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
  major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"; patch="${BASH_REMATCH[3]}"
  [[ "$minimum" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
  minimum_major="${BASH_REMATCH[1]}"; minimum_minor="${BASH_REMATCH[2]}"; minimum_patch="${BASH_REMATCH[3]}"

  if (( 10#$major > 10#$minimum_major )); then return 0; fi
  if (( 10#$major < 10#$minimum_major )); then return 1; fi
  if (( 10#$minor > 10#$minimum_minor )); then return 0; fi
  if (( 10#$minor < 10#$minimum_minor )); then return 1; fi
  if (( 10#$patch >= 10#$minimum_patch )); then return 0; fi
  return 1
}
