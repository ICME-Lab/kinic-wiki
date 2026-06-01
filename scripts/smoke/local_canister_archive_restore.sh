#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/smoke/local_canister_archive_restore.sh
# What: Run archive/restore smoke against the project-local wiki canister.
# Why: SQLite byte archive flows need a deployed local canister check beyond Rust unit tests.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IDS_FILE="${REPO_ROOT}/.icp/cache/mappings/local-wiki.ids.json"
REPLICA_HOST="${REPLICA_HOST:-http://127.0.0.1:8001}"

resolve_canister_id() {
  if [[ -n "${VFS_CANISTER_ID:-}" ]]; then
    printf '%s\n' "${VFS_CANISTER_ID}"
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
  if [[ -n "${CANISTER_ID:-}" ]]; then
    printf '%s\n' "${CANISTER_ID}"
    return 0
  fi
  return 1
}

canister_has_module() {
  local canister_id="$1"
  icp canister status "$canister_id" -e local-wiki --json \
    | node -e '
      const fs = require("fs");
      const status = JSON.parse(fs.readFileSync(0, "utf8"));
      process.exit(status.module_hash ? 0 : 1);
    '
}

cd "${REPO_ROOT}"

if ! CANISTER_ID="$(resolve_canister_id)"; then
  echo "local wiki canister id not found; deploying wiki to local-wiki environment" >&2
  scripts/local/deploy_wiki.sh
  CANISTER_ID="$(resolve_canister_id)"
fi
if canister_has_module "$CANISTER_ID" >/dev/null 2>&1; then
  echo "deploying current wiki canister to local-wiki environment" >&2
else
  echo "local wiki canister ${CANISTER_ID} missing installed module; deploying wiki to local-wiki environment" >&2
fi
scripts/local/deploy_wiki.sh
CANISTER_ID="$(resolve_canister_id)"

export CANISTER_ID
export REPLICA_HOST

echo "running local canister archive/restore smoke against ${CANISTER_ID} at ${REPLICA_HOST}" >&2
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
STATE_FILE="${TMP_DIR}/local_canister_archive_restore_state.json"
cargo run -p kinic-vfs-cli --bin local_canister_archive_restore_smoke -- --state-output "$STATE_FILE"

echo "upgrading local wiki canister before persistence verification" >&2
MODE=upgrade scripts/local/deploy_wiki.sh
cargo run -p kinic-vfs-cli --bin local_canister_archive_restore_smoke -- --verify-state "$STATE_FILE"

INPUT_FILE="${TMP_DIR}/smoke.md"
ARCHIVE_FILE="${TMP_DIR}/archive.sqlite"
CLI_WORKSPACE="${TMP_DIR}/cli-workspace"
mkdir -p "${CLI_WORKSPACE}"
printf '# CLI Archive Smoke\n\nalpha archive restore smoke\n' > "$INPUT_FILE"

VFS=(cargo run --manifest-path "${REPO_ROOT}/Cargo.toml" -p kinic-vfs-cli --bin kinic-vfs-cli -- --allow-non-ii-identity --replica-host "$REPLICA_HOST" --canister-id "$CANISTER_ID")
CLI_DB_NAME="${CLI_DB_NAME:-Archive smoke CLI}"
CLI_DB="$(cd "$CLI_WORKSPACE" && "${VFS[@]}" database create "$CLI_DB_NAME")"
(
  cd "$CLI_WORKSPACE"
  "${VFS[@]}" --database-id "$CLI_DB" write-node --path /Wiki/smoke.md --input "$INPUT_FILE"
  "${VFS[@]}" database archive-export "$CLI_DB" --output "$ARCHIVE_FILE" --chunk-size 65536 --json
  "${VFS[@]}" database archive-restore "$CLI_DB" --input "$ARCHIVE_FILE" --chunk-size 65536 --json
  "${VFS[@]}" --identity-mode identity --database-id "$CLI_DB" read-node --path /Wiki/smoke.md --fields path,etag --json
)
