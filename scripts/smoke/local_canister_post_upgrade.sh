#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/smoke/local_canister_post_upgrade.sh
# What: Smoke local install/upgrade with explicit cycles config and pending DB persistence.
# Why: Constructor args are operationally required, and post_upgrade must preserve initialized state.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ICP_ENVIRONMENT="${ICP_ENVIRONMENT:-local-wiki}"
IDS_FILE="${REPO_ROOT}/.icp/cache/mappings/${ICP_ENVIRONMENT}.ids.json"
REPLICA_HOST="${REPLICA_HOST:-http://127.0.0.1:8011}"
SMOKE_CYCLE_PURCHASE_E8S="${SMOKE_CYCLE_PURCHASE_E8S:-100000000}"
SMOKE_CYCLES_ALLOWANCE_E8S="${SMOKE_CYCLES_ALLOWANCE_E8S:-200000000}"

case "${ICP_ENVIRONMENT}" in
  local | local-wiki) ;;
  *)
    echo "ICP_ENVIRONMENT must be local or local-wiki for local smoke" >&2
    exit 1
    ;;
esac

validate_unsigned_integer() {
  local name="$1"
  local value="${!name:-}"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "${name} must be an unsigned integer" >&2
    exit 1
  fi
}

current_identity_name() {
  icp identity list | awk '$1 == "*" { print $2; found = 1 } END { if (!found) exit 1 }'
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

approve_cycles_allowance() {
  local canister_id="$1"
  echo "approving ${SMOKE_CYCLES_ALLOWANCE_E8S} e8s for wiki canister ${canister_id}" >&2
  local approve_result
  if ! approve_result="$(icp canister call "${KINIC_LEDGER_CANISTER_ID}" icrc2_approve \
    "(record { spender = record { owner = principal \"${canister_id}\"; subaccount = null }; amount = ${SMOKE_CYCLES_ALLOWANCE_E8S} : nat; expected_allowance = null; expires_at = null; fee = null; memo = null; from_subaccount = null; created_at_time = null })" \
    -e "${ICP_ENVIRONMENT}" -o candid)"; then
    echo "KINIC approve failed. Ensure the current identity has enough local KINIC balance for the smoke cycle purchase plus ledger fees." >&2
    exit 1
  fi
  if [[ "${approve_result}" == *"Err"* ]]; then
    echo "KINIC approve returned an error: ${approve_result}" >&2
    echo "Ensure the current identity has enough local KINIC balance for the smoke cycle purchase plus ledger fees." >&2
    exit 1
  fi
}

cd "${REPO_ROOT}"
validate_unsigned_integer SMOKE_CYCLE_PURCHASE_E8S
validate_unsigned_integer SMOKE_CYCLES_ALLOWANCE_E8S

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ -z "${VFS_IDENTITY_PEM_PATH:-}" ]]; then
  VFS_IDENTITY_PEM_PATH="${TMP_DIR}/identity.pem"
  IDENTITY_NAME="$(current_identity_name)"
  if [[ -z "${IDENTITY_NAME}" ]]; then
    echo "current icp identity name could not be resolved" >&2
    exit 1
  fi
  (umask 077 && icp identity export "${IDENTITY_NAME}" > "$VFS_IDENTITY_PEM_PATH")
  export VFS_IDENTITY_PEM_PATH
fi

if [[ -z "${BILLING_AUTHORITY_ID:-}" ]]; then
  BILLING_AUTHORITY_ID="$(icp identity principal)"
  export BILLING_AUTHORITY_ID
fi

LEDGER_SETUP_OUTPUT="$(ICP_ENVIRONMENT="${ICP_ENVIRONMENT}" bash scripts/local/setup_kinic_ledger.sh)"
KINIC_LEDGER_CANISTER_ID="${LEDGER_SETUP_OUTPUT#KINIC_LEDGER_CANISTER_ID=}"
export ICP_ENVIRONMENT
export KINIC_LEDGER_CANISTER_ID
export SMOKE_CYCLE_PURCHASE_E8S

scripts/local/deploy_wiki.sh
CANISTER_ID="$(resolve_canister_id)"
export CANISTER_ID
export REPLICA_HOST
approve_cycles_allowance "${CANISTER_ID}"

STATE_FILE="${TMP_DIR}/local_canister_post_upgrade_state.json"
cargo run -p kinic-vfs-cli --bin local_canister_post_upgrade_smoke -- --state-output "$STATE_FILE"

MODE=upgrade scripts/local/deploy_wiki.sh
cargo run -p kinic-vfs-cli --bin local_canister_post_upgrade_smoke -- --verify-state "$STATE_FILE"
