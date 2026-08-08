#!/usr/bin/env bash
# Shared protected-release provenance validation for deploy and rollback.
# Callers provide their own fail() policy; these helpers only return non-zero.

release_record_mode_is_protected() {
  [[ -f "$1" && -s "$1" && "$(stat -c '%a' "$1")" == 600 ]]
}

load_verified_baseline_release() {
  local record=$1 service upper tag_var id_var actual
  release_record_mode_is_protected "$record" || { echo "baseline release record must exist, be non-empty, and have mode 600: $record" >&2; return 1; }
  unset RELEASE_SHA API_IMAGE_TAG API_IMAGE_ID WEB_IMAGE_TAG WEB_IMAGE_ID CADDY_IMAGE_TAG CADDY_IMAGE_ID LIVEKIT_IMAGE_TAG LIVEKIT_IMAGE_ID
  # Records are generated in the root-owned release directory by deploy.sh.
  # shellcheck disable=SC1090
  source "$record"
  [[ "${RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo 'baseline release record lacks a full RELEASE_SHA' >&2; return 1; }
  for service in api web caddy livekit; do
    upper="$(tr '[:lower:]' '[:upper:]' <<<"$service")"; tag_var="${upper}_IMAGE_TAG"; id_var="${upper}_IMAGE_ID"
    [[ -n "${!tag_var:-}" && -n "${!id_var:-}" ]] || { echo "baseline record lacks immutable image provenance for $service" >&2; return 1; }
    actual="$(docker image inspect --format '{{.Id}}' "${!tag_var}" 2>/dev/null || true)"
    [[ "$actual" == "${!id_var}" ]] || { echo "baseline image tag does not resolve to recorded immutable ID: ${!tag_var}" >&2; return 1; }
  done
}

load_verified_pending_deployment() {
  local record=$1 service upper tag_var id_var
  release_record_mode_is_protected "$record" || { echo "pending deployment record must exist, be non-empty, and have mode 600: $record" >&2; return 1; }
  unset RECORD_STATE CANDIDATE_SHA DATABASE_BACKUP DATABASE_BACKUP_SHA256 PREVIOUS_RELEASE_SHA PREVIOUS_API_IMAGE_TAG PREVIOUS_API_IMAGE_ID PREVIOUS_WEB_IMAGE_TAG PREVIOUS_WEB_IMAGE_ID PREVIOUS_CADDY_IMAGE_TAG PREVIOUS_CADDY_IMAGE_ID PREVIOUS_LIVEKIT_IMAGE_TAG PREVIOUS_LIVEKIT_IMAGE_ID
  # shellcheck disable=SC1090
  source "$record"
  [[ "${RECORD_STATE:-}" == pending && "${CANDIDATE_SHA:-}" =~ ^[0-9a-f]{40}$ && "${PREVIOUS_RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo 'pending record is not a complete deployment transaction' >&2; return 1; }
  [[ -n "${DATABASE_BACKUP:-}" && "${DATABASE_BACKUP_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || { echo 'pending record lacks backup checksum provenance' >&2; return 1; }
  for service in api web caddy livekit; do
    upper="$(tr '[:lower:]' '[:upper:]' <<<"$service")"; tag_var="PREVIOUS_${upper}_IMAGE_TAG"; id_var="PREVIOUS_${upper}_IMAGE_ID"
    [[ -n "${!tag_var:-}" && -n "${!id_var:-}" ]] || { echo "pending record lacks predecessor provenance for $service" >&2; return 1; }
  done
}
