#!/usr/bin/env bash
# Where: scripts/guard_kinic_vfs_cli_npm_publish.sh
# What: Refuse npm publishing unless the workflow runs from the matching release tag.
# Why: npm package contents must correspond to the GitHub Release source and assets.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(bash "$repo_root/scripts/kinic_vfs_cli_release_version.sh")"

if [ "${GITHUB_REF_TYPE:-}" != "tag" ] || [ "${GITHUB_REF_NAME:-}" != "$version" ]; then
  echo "npm publish must run from tag $version" >&2
  exit 1
fi

printf 'npm publish tag guard passed for %s\n' "$version"
