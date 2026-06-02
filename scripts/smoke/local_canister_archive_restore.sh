#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/smoke/local_canister_archive_restore.sh
# What: Run archive/restore smoke against the project-local wiki canister.
# Why: SQLite byte archive flows need a deployed local canister check beyond Rust unit tests.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ICP_ENVIRONMENT="${ICP_ENVIRONMENT:-local-wiki}"
IDS_FILE="${REPO_ROOT}/.icp/cache/mappings/${ICP_ENVIRONMENT}.ids.json"
SMOKE_CYCLE_PURCHASE_E8S="${SMOKE_CYCLE_PURCHASE_E8S:-100000000}"
SMOKE_CYCLE_PURCHASE_KINIC="${SMOKE_CYCLE_PURCHASE_KINIC:-1}"
SMOKE_CYCLE_PURCHASE_COUNT="${SMOKE_CYCLE_PURCHASE_COUNT:-3}"
SMOKE_CYCLES_ALLOWANCE_E8S="${SMOKE_CYCLES_ALLOWANCE_E8S:-400000000}"

case "${ICP_ENVIRONMENT}" in
  local | local-wiki) ;;
  *)
    echo "ICP_ENVIRONMENT must be local or local-wiki for local smoke" >&2
    exit 1
    ;;
esac

current_identity_principal() {
  icp identity principal
}

network_api_url() {
  icp network status -e "${ICP_ENVIRONMENT}" --json \
    | node -e '
      const fs = require("fs");
      const status = JSON.parse(fs.readFileSync(0, "utf8"));
      if (typeof status.api_url !== "string" || status.api_url.trim() === "") {
        process.exit(1);
      }
      process.stdout.write(status.api_url.replace(/\/$/, ""));
    '
}

validate_unsigned_integer() {
  local name="$1"
  local value="${!name:-}"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "${name} must be an unsigned integer" >&2
    exit 1
  fi
}

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
  icp canister status "$canister_id" -e "${ICP_ENVIRONMENT}" --json \
    | node -e '
      const fs = require("fs");
      const status = JSON.parse(fs.readFileSync(0, "utf8"));
      process.exit(status.module_hash ? 0 : 1);
    '
}

wiki_ledger_canister_id() {
  icp canister call wiki get_cycles_billing_config '()' -e "${ICP_ENVIRONMENT}" -o candid 2>/dev/null \
    | awk -F'"' '/kinic_ledger_canister_id/ { print $2; exit }'
}

deploy_wiki() {
  ICP_ENVIRONMENT="${ICP_ENVIRONMENT}" \
    KINIC_LEDGER_CANISTER_ID="${KINIC_LEDGER_CANISTER_ID}" \
    BILLING_AUTHORITY_ID="${BILLING_AUTHORITY_ID}" \
    bash scripts/local/deploy_wiki.sh "$@"
}

approve_cycles_allowance() {
  local canister_id="$1"
  echo "approving ${SMOKE_CYCLES_ALLOWANCE_E8S} e8s for wiki canister ${canister_id}" >&2
  local approve_result
  if ! approve_result="$(icp canister call "${KINIC_LEDGER_CANISTER_ID}" icrc2_approve \
    "(record { spender = record { owner = principal \"${canister_id}\"; subaccount = null }; amount = ${SMOKE_CYCLES_ALLOWANCE_E8S} : nat; expected_allowance = null; expires_at = null; fee = null; memo = null; from_subaccount = null; created_at_time = null })" \
    -e "${ICP_ENVIRONMENT}" -o candid)"; then
    echo "KINIC approve failed. Ensure the current identity has enough local KINIC balance for ${SMOKE_CYCLE_PURCHASE_COUNT} cycle purchases plus ledger fees." >&2
    exit 1
  fi
  if [[ "${approve_result}" == *"Err"* ]]; then
    echo "KINIC approve returned an error: ${approve_result}" >&2
    echo "Ensure the current identity has enough local KINIC balance for ${SMOKE_CYCLE_PURCHASE_COUNT} cycle purchases plus ledger fees." >&2
    exit 1
  fi
}

cd "${REPO_ROOT}"
validate_unsigned_integer SMOKE_CYCLE_PURCHASE_E8S
validate_unsigned_integer SMOKE_CYCLE_PURCHASE_COUNT
validate_unsigned_integer SMOKE_CYCLES_ALLOWANCE_E8S
if [[ -z "${BILLING_AUTHORITY_ID:-}" ]]; then
  export BILLING_AUTHORITY_ID="$(current_identity_principal)"
fi

if [[ -z "${REPLICA_HOST:-}" ]]; then
  REPLICA_HOST="$(network_api_url)"
fi
export REPLICA_HOST

LEDGER_SETUP_OUTPUT="$(ICP_ENVIRONMENT="${ICP_ENVIRONMENT}" bash scripts/local/setup_kinic_ledger.sh)"
KINIC_LEDGER_CANISTER_ID="${LEDGER_SETUP_OUTPUT#KINIC_LEDGER_CANISTER_ID=}"
export KINIC_LEDGER_CANISTER_ID
export SMOKE_CYCLE_PURCHASE_E8S

if ! CANISTER_ID="$(resolve_canister_id)"; then
  echo "local wiki canister id not found; deploying wiki to ${ICP_ENVIRONMENT} environment" >&2
  deploy_wiki
  CANISTER_ID="$(resolve_canister_id)"
fi
if canister_has_module "$CANISTER_ID" >/dev/null 2>&1; then
  CURRENT_LEDGER_CANISTER_ID="$(wiki_ledger_canister_id || true)"
  if [[ "${CURRENT_LEDGER_CANISTER_ID}" != "${KINIC_LEDGER_CANISTER_ID}" ]]; then
    echo "wiki ledger mismatch (${CURRENT_LEDGER_CANISTER_ID:-missing}); reinstalling wiki for ${KINIC_LEDGER_CANISTER_ID}" >&2
    deploy_wiki --mode reinstall
  else
    echo "deploying current wiki canister to ${ICP_ENVIRONMENT} environment" >&2
    deploy_wiki
  fi
else
  echo "local wiki canister ${CANISTER_ID} missing installed module; deploying wiki to ${ICP_ENVIRONMENT} environment" >&2
  deploy_wiki
fi
CANISTER_ID="$(resolve_canister_id)"

export CANISTER_ID
approve_cycles_allowance "${CANISTER_ID}"

echo "running local canister archive/restore smoke against ${CANISTER_ID} at ${REPLICA_HOST}" >&2
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
STATE_FILE="${TMP_DIR}/local_canister_archive_restore_state.json"
cargo run -p kinic-vfs-cli --bin local_canister_archive_restore_smoke -- --state-output "$STATE_FILE"

echo "upgrading local wiki canister before persistence verification" >&2
deploy_wiki --mode upgrade
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
  "${VFS[@]}" database purchase-cycles "$CLI_DB" "$SMOKE_CYCLE_PURCHASE_KINIC"
  "${VFS[@]}" --database-id "$CLI_DB" write-node --path /Wiki/smoke.md --input "$INPUT_FILE"
  "${VFS[@]}" database archive-export "$CLI_DB" --output "$ARCHIVE_FILE" --chunk-size 65536 --json
  "${VFS[@]}" database archive-restore "$CLI_DB" --input "$ARCHIVE_FILE" --chunk-size 65536 --json
  "${VFS[@]}" --identity-mode identity --database-id "$CLI_DB" read-node --path /Wiki/smoke.md --fields path,etag --json
)
