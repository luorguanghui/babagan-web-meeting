#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 LIVE_DATABASE BACKUP_DIRECTORY [RETENTION_COUNT]" >&2
  exit 64
}

[[ $# -ge 2 && $# -le 3 ]] || usage
live_database=$1
backup_directory=$2
retention_count=${3:-7}

[[ -f "$live_database" ]] || { echo "Live database does not exist: $live_database" >&2; exit 66; }
[[ "$retention_count" =~ ^[1-9][0-9]*$ ]] || { echo 'RETENTION_COUNT must be a positive integer.' >&2; exit 64; }
case "$live_database$backup_directory" in *"'"*) echo "Paths containing a single quote are not supported by sqlite .backup." >&2; exit 64;; esac
command -v sqlite3 >/dev/null || { echo 'sqlite3 is required for an online SQLite backup.' >&2; exit 69; }
command -v sha256sum >/dev/null || { echo 'sha256sum is required to checksum backups.' >&2; exit 69; }

umask 077
mkdir -p "$backup_directory"
chmod 700 "$backup_directory"
live_database=$(cd "$(dirname "$live_database")" && pwd -P)/$(basename "$live_database")
backup_directory=$(cd "$backup_directory" && pwd -P)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_name="meetings-${timestamp}.sqlite"
temporary_backup=$(mktemp "$backup_directory/.${backup_name}.XXXXXX")
final_backup="$backup_directory/$backup_name"

cleanup() { rm -f -- "$temporary_backup"; }
trap cleanup EXIT

# SQLite's .backup command takes a consistent online snapshot without stopping the API.
sqlite3 "$live_database" ".backup '$temporary_backup'"
integrity=$(sqlite3 "$temporary_backup" 'PRAGMA integrity_check;')
[[ "$integrity" == 'ok' ]] || { echo "Backup integrity check failed: $integrity" >&2; exit 65; }
mv -- "$temporary_backup" "$final_backup"
chmod 600 "$final_backup"
(cd "$backup_directory" && sha256sum "$backup_name" > "$backup_name.sha256")
chmod 600 "$final_backup.sha256"
trap - EXIT

mapfile -t backups < <(find "$backup_directory" -maxdepth 1 -type f -name 'meetings-*.sqlite' -printf '%f\n' | LC_ALL=C sort)
while ((${#backups[@]} > retention_count)); do
  oldest=${backups[0]}
  rm -f -- "$backup_directory/$oldest" "$backup_directory/$oldest.sha256"
  backups=("${backups[@]:1}")
done

echo "Backup created: $final_backup"
