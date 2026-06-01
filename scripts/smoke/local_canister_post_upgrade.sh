#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/smoke/local_canister_post_upgrade.sh
# What: Smoke local install/upgrade with explicit cycles config and pending DB persistence.
# Why: Constructor args are operationally required, and post_upgrade must preserve initialized state.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IDS_FILE="${REPO_ROOT}/.icp/cache/mappings/local-wiki.ids.json"
REPLICA_HOST="${REPLICA_HOST:-http://127.0.0.1:8001}"

resolve_canister_id() {
  if [[ -n "${VFS_CANISTER_ID:-}" ]]; then
    printf '%s\n' "${VFS_CANISTER_ID}"
    return 0
  fi
  if [[ -n "${CANISTER_ID:-}" ]]; then
    printf '%s\n' "${CANISTER_ID}"
    return 0
  fi
  if [[ -f "${IDS_FILE}" ]]; then
    node -e '
      const fs = require("fs");
      const [filePath] = process.argv.slice(1);
      const ids = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (typeof ids.wiki !== "string" || ids.wiki.trim() === "") {
        process.exit(1);
      }
      process.stdout.write(ids.wiki);
    ' "${IDS_FILE}"
    return 0
  fi
  return 1
}

cd "${REPO_ROOT}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ -z "${VFS_IDENTITY_PEM_PATH:-}" ]]; then
  VFS_IDENTITY_PEM_PATH="${TMP_DIR}/identity.pem"
  icp identity export > "$VFS_IDENTITY_PEM_PATH"
  export VFS_IDENTITY_PEM_PATH
fi

if [[ -z "${BILLING_AUTHORITY_ID:-}" ]]; then
  BILLING_AUTHORITY_ID="$(icp identity principal)"
  export BILLING_AUTHORITY_ID
fi

scripts/local/deploy_wiki.sh
CANISTER_ID="$(resolve_canister_id)"
export CANISTER_ID
export REPLICA_HOST

STATE_FILE="${TMP_DIR}/local_canister_post_upgrade_state.json"
cargo run -p kinic-vfs-cli --bin local_canister_post_upgrade_smoke -- --state-output "$STATE_FILE"

MODE=upgrade scripts/local/deploy_wiki.sh
cargo run -p kinic-vfs-cli --bin local_canister_post_upgrade_smoke -- --verify-state "$STATE_FILE"
