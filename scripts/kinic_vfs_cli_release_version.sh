#!/usr/bin/env bash
# Keep Cargo, npm and Cargo.lock aligned for CI packaging and both release routes.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(python3 "$repo_root/scripts/cli_release.py" version)"
case "${1:-}" in
  --plain) printf '%s\n' "$version" ;;
  "") printf 'v%s\n' "$version" ;;
  *) echo "usage: scripts/kinic_vfs_cli_release_version.sh [--plain]" >&2; exit 64 ;;
esac
