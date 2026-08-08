#!/usr/bin/env bash
# Strict, non-executing release-record parser shared by deploy and rollback.
# Values are deliberately restricted to operational identifiers/paths so no
# record line can become shell syntax.

record_error() { printf 'release record rejected: %s\n' "$*" >&2; return 1; }

clear_record_variables() {
  unset RECORD_STATE BOOTSTRAP_EMPTY CANDIDATE_SHA STARTED_AT_UTC RELEASE_SHA DEPLOYED_AT_UTC DATABASE_BACKUP DATABASE_BACKUP_SHA256 OVERRIDE_FILE IS_BOOTSTRAP_PENDING BOOTSTRAP_VOLUME_NAME BOOTSTRAP_VOLUME_MOUNTPOINT BOOTSTRAP_VOLUME_PROJECT BOOTSTRAP_VOLUME_MARKER_ID
  unset API_IMAGE_TAG API_IMAGE_ID WEB_IMAGE_TAG WEB_IMAGE_ID CADDY_IMAGE_TAG CADDY_IMAGE_ID LIVEKIT_IMAGE_TAG LIVEKIT_IMAGE_ID
  unset PREVIOUS_RELEASE_SHA PREVIOUS_API_IMAGE_TAG PREVIOUS_API_IMAGE_ID PREVIOUS_WEB_IMAGE_TAG PREVIOUS_WEB_IMAGE_ID PREVIOUS_CADDY_IMAGE_TAG PREVIOUS_CADDY_IMAGE_ID PREVIOUS_LIVEKIT_IMAGE_TAG PREVIOUS_LIVEKIT_IMAGE_ID
}

parse_protected_release_record() {
  local record=$1 line key value
  declare -A allowed=()
  declare -A seen=()
  for key in RECORD_STATE BOOTSTRAP_EMPTY CANDIDATE_SHA STARTED_AT_UTC RELEASE_SHA DEPLOYED_AT_UTC DATABASE_BACKUP DATABASE_BACKUP_SHA256 OVERRIDE_FILE BOOTSTRAP_VOLUME_NAME BOOTSTRAP_VOLUME_MOUNTPOINT BOOTSTRAP_VOLUME_PROJECT BOOTSTRAP_VOLUME_MARKER_ID API_IMAGE_TAG API_IMAGE_ID WEB_IMAGE_TAG WEB_IMAGE_ID CADDY_IMAGE_TAG CADDY_IMAGE_ID LIVEKIT_IMAGE_TAG LIVEKIT_IMAGE_ID PREVIOUS_RELEASE_SHA PREVIOUS_API_IMAGE_TAG PREVIOUS_API_IMAGE_ID PREVIOUS_WEB_IMAGE_TAG PREVIOUS_WEB_IMAGE_ID PREVIOUS_CADDY_IMAGE_TAG PREVIOUS_CADDY_IMAGE_ID PREVIOUS_LIVEKIT_IMAGE_TAG PREVIOUS_LIVEKIT_IMAGE_ID; do allowed[$key]=1; done
  [[ -f "$record" && -s "$record" && "$(stat -c '%a' "$record")" == 600 ]] || { record_error "must exist, be non-empty, and have mode 600: $record"; return 1; }
  clear_record_variables
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([A-Z0-9_]+)=([A-Za-z0-9_./:@+,-]+)$ ]] || { record_error 'line is not a strict KEY=VALUE record'; return 1; }
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    [[ -n "${allowed[$key]:-}" ]] || { record_error "unknown key: $key"; return 1; }
    [[ -z "${seen[$key]:-}" ]] || { record_error "duplicate key: $key"; return 1; }
    seen[$key]=1
    printf -v "$key" '%s' "$value"
  done <"$record"
}

load_verified_baseline_release() {
  local record=$1 service upper tag_var id_var actual
  parse_protected_release_record "$record" || return 1
  [[ -z "${RECORD_STATE:-}" && -z "${CANDIDATE_SHA:-}" && -z "${STARTED_AT_UTC:-}" ]] || { record_error 'baseline must not be a pending transaction'; return 1; }
  [[ "${RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { record_error 'baseline lacks a full RELEASE_SHA'; return 1; }
  for service in api web caddy livekit; do
    upper="$(tr '[:lower:]' '[:upper:]' <<<"$service")"; tag_var="${upper}_IMAGE_TAG"; id_var="${upper}_IMAGE_ID"
    [[ -n "${!tag_var:-}" && -n "${!id_var:-}" ]] || { record_error "baseline lacks immutable image provenance for $service"; return 1; }
    actual="$(docker image inspect --format '{{.Id}}' "${!tag_var}" 2>/dev/null || true)"
    [[ "$actual" == "${!id_var}" ]] || { record_error "baseline image tag does not resolve to recorded immutable ID: ${!tag_var}"; return 1; }
  done
}

load_verified_pending_deployment() {
  local record=$1 service upper tag_var id_var
  parse_protected_release_record "$record" || return 1
  IS_BOOTSTRAP_PENDING=0
  if [[ "${RECORD_STATE:-}" == bootstrap-pending ]]; then
    [[ "${BOOTSTRAP_EMPTY:-}" == 1 && "${CANDIDATE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { record_error 'not a complete empty-environment bootstrap transaction'; return 1; }
    [[ -z "${PREVIOUS_RELEASE_SHA:-}" && -z "${DATABASE_BACKUP:-}" && -z "${RELEASE_SHA:-}" && -z "${API_IMAGE_TAG:-}" ]] || { record_error 'bootstrap record must not claim predecessor or release state'; return 1; }
    local bootstrap_field_count=0 field
    for field in BOOTSTRAP_VOLUME_NAME BOOTSTRAP_VOLUME_MOUNTPOINT BOOTSTRAP_VOLUME_PROJECT BOOTSTRAP_VOLUME_MARKER_ID; do [[ -n "${!field:-}" ]] && ((bootstrap_field_count+=1)); done
    [[ $bootstrap_field_count == 0 || $bootstrap_field_count == 4 ]] || { record_error 'bootstrap volume provenance must be complete or absent'; return 1; }
    IS_BOOTSTRAP_PENDING=1
    return 0
  fi
  [[ "${RECORD_STATE:-}" == pending && -z "${BOOTSTRAP_EMPTY:-}" && "${CANDIDATE_SHA:-}" =~ ^[0-9a-f]{40}$ && "${PREVIOUS_RELEASE_SHA:-}" =~ ^[0-9a-f]{40}$ && -z "${RELEASE_SHA:-}" ]] || { record_error 'not a complete deployment transaction'; return 1; }
  [[ -n "${DATABASE_BACKUP:-}" && "${DATABASE_BACKUP_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || { record_error 'pending record lacks backup checksum provenance'; return 1; }
  for service in api web caddy livekit; do
    upper="$(tr '[:lower:]' '[:upper:]' <<<"$service")"; tag_var="PREVIOUS_${upper}_IMAGE_TAG"; id_var="PREVIOUS_${upper}_IMAGE_ID"
    [[ -n "${!tag_var:-}" && -n "${!id_var:-}" ]] || { record_error "pending record lacks predecessor provenance for $service"; return 1; }
  done
}
