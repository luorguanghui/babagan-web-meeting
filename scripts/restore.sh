#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 BACKUP_DATABASE RESTORE_DIRECTORY" >&2
  echo 'This command creates a new verified file. It never replaces the live database.' >&2
  exit 64
}

[[ $# -eq 2 ]] || usage
backup_database=$1
restore_directory=$2
[[ -f "$backup_database" ]] || { echo "Backup database does not exist: $backup_database" >&2; exit 66; }
case "$backup_database$restore_directory" in *"'"*) echo "Paths containing a single quote are not supported by sqlite .backup." >&2; exit 64;; esac
command -v sqlite3 >/dev/null || { echo 'sqlite3 is required to restore SQLite backups.' >&2; exit 69; }
command -v sha256sum >/dev/null || { echo 'sha256sum is required to verify SQLite backups.' >&2; exit 69; }

backup_directory=$(cd "$(dirname "$backup_database")" && pwd -P)
backup_name=$(basename "$backup_database")
checksum_file="$backup_directory/$backup_name.sha256"
[[ -f "$checksum_file" ]] || { echo "Checksum sidecar is required: $checksum_file" >&2; exit 65; }
(cd "$backup_directory" && sha256sum -c "$(basename "$checksum_file")")

umask 077
mkdir -p "$restore_directory"
chmod 700 "$restore_directory"
restore_directory=$(cd "$restore_directory" && pwd -P)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
restored_database="$restore_directory/meetings-restored-${timestamp}.sqlite"
[[ ! -e "$restored_database" ]] || { echo "Refusing to overwrite existing restore: $restored_database" >&2; exit 73; }

# The destination is always a new file; swapping it into service is a separate, explicit operator action.
sqlite3 "$backup_database" ".backup '$restored_database'"
integrity=$(sqlite3 "$restored_database" 'PRAGMA integrity_check;')
[[ "$integrity" == 'ok' ]] || { rm -f -- "$restored_database"; echo "Restore integrity check failed: $integrity" >&2; exit 65; }
chmod 600 "$restored_database"

echo "Verified restore created: $restored_database"
echo 'No live database was changed. Stop the API and perform any file swap yourself after reviewing this restore.'
