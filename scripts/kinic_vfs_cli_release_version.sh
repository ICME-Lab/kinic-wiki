#!/usr/bin/env bash
# Where: scripts/kinic_vfs_cli_release_version.sh
# What: Resolve and verify the release version shared by Cargo, npm, and CI.
# Why: Release artifacts and npm installs must point at the same versioned assets.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
npm_package="$repo_root/npm/kinic-vfs-cli/package.json"
cargo_toml="$repo_root/crates/vfs_cli_app/Cargo.toml"

version="$(
  node -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(pkg.version);' "$npm_package"
)"

cargo_version=""
while IFS= read -r line; do
  case "$line" in
    "version = \""*)
      cargo_version="${line#version = \"}"
      cargo_version="${cargo_version%\"}"
      break
      ;;
  esac
done < "$cargo_toml"

if [ -z "$cargo_version" ]; then
  echo "version missing in $cargo_toml" >&2
  exit 1
fi

if [ "$cargo_version" != "$version" ]; then
  echo "version mismatch: Cargo=$cargo_version npm=$version" >&2
  exit 1
fi

case "${1:-}" in
  --plain)
    printf '%s\n' "$version"
    ;;
  "")
    printf 'v%s\n' "$version"
    ;;
  *)
    echo "usage: scripts/kinic_vfs_cli_release_version.sh [--plain]" >&2
    exit 64
    ;;
esac
