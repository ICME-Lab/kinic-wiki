#!/usr/bin/env bash
# Where: scripts/install-codex-skill-recorder.sh
# What: Compatibility wrapper for installing the Codex plugin.
# Why: Plugin source now lives under plugins/codex and kinic-vfs-cli embeds it directly.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -n "${KINIC_VFS_CLI:-}" ]; then
  exec "$KINIC_VFS_CLI" codex setup
fi

if [ -x "$repo_root/target/debug/kinic-vfs-cli" ]; then
  exec "$repo_root/target/debug/kinic-vfs-cli" codex setup
fi

exec cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- codex setup
