#!/usr/bin/env bash
# Update an existing installation without checking out/resetting its working tree.
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
command -v python3 >/dev/null || { echo 'Python 3 is required.' >&2; exit 69; }
exec python3 "$script_dir/update-release.py" "$@"
