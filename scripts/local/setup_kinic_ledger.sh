#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/local/setup_kinic_ledger.sh
# What: Prepare a project-local ICRC ledger for KINIC cycle purchase smoke tests.
# Why: The wiki canister stores the ledger principal at init, so local smoke needs a real ledger before deploy.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ICP_ENVIRONMENT="${ICP_ENVIRONMENT:-local-wiki}"
LEDGER_ID_DIR="${REPO_ROOT}/.icp/cache/local-kinic-ledger"
LEDGER_ID_FILE="${LEDGER_ID_DIR}/${ICP_ENVIRONMENT}.id"
DEFAULT_INITIAL_BALANCE_E8S="${KINIC_LEDGER_INITIAL_BALANCE_E8S:-100000000000}"
LEDGER_TRANSFER_FEE_E8S="${KINIC_LEDGER_TRANSFER_FEE_E8S:-100000}"

case "${ICP_ENVIRONMENT}" in
  local | local-wiki) ;;
  *)
    echo "ICP_ENVIRONMENT must be local or local-wiki for local ledger setup" >&2
    exit 1
    ;;
esac

cd "${REPO_ROOT}"

current_identity_principal() {
  icp identity principal
}

require_unsigned_integer() {
  local name="$1"
  local value="${!name:-}"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "${name} must be an unsigned integer" >&2
    exit 1
  fi
}

canister_exists() {
  local canister_id="$1"
  icp canister status "${canister_id}" -e "${ICP_ENVIRONMENT}" --json >/dev/null 2>&1
}

canister_has_module() {
  local canister_id="$1"
  icp canister status "${canister_id}" -e "${ICP_ENVIRONMENT}" --json \
    | node -e '
      const fs = require("fs");
      const status = JSON.parse(fs.readFileSync(0, "utf8"));
      process.exit(status.module_hash ? 0 : 1);
    '
}

resolve_ledger_wasm() {
  if [[ -n "${KINIC_LEDGER_WASM:-}" ]]; then
    if [[ ! -f "${KINIC_LEDGER_WASM}" ]]; then
      echo "KINIC_LEDGER_WASM does not exist: ${KINIC_LEDGER_WASM}" >&2
      exit 1
    fi
    printf '%s\n' "${KINIC_LEDGER_WASM}"
    return 0
  fi

  local candidates=(
    "${HOME}/.cache/kasane-local-ledger/ic-icrc1-ledger.wasm"
    "${HOME}/Desktop/ICP/Kasane/third_party/dfinity/ledger-suite-icrc-2026-03-09/ic-icrc1-ledger.wasm"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  echo "ICRC ledger wasm not found. Set KINIC_LEDGER_WASM=/path/to/ic-icrc1-ledger.wasm." >&2
  exit 1
}

create_detached_ledger() {
  local result
  result="$(icp canister create --detached -e "${ICP_ENVIRONMENT}" --json)"
  node -e '
    const value = JSON.parse(process.argv[1]);
    if (typeof value.canister_id !== "string" || value.canister_id.trim() === "") {
      throw new Error("detached canister creation did not return canister_id");
    }
    process.stdout.write(value.canister_id);
  ' "${result}"
}

install_ledger() {
  local canister_id="$1"
  local wasm_path="$2"
  local owner="$3"
  local install_mode="$4"
  local args_file
  args_file="$(mktemp "${TMPDIR:-/tmp}/kinic-ledger-init.XXXXXX.did")"

  cat >"${args_file}" <<EOF
(variant { Init = record {
  minting_account = record { owner = principal "aaaaa-aa"; subaccount = null };
  fee_collector_account = null;
  transfer_fee = ${LEDGER_TRANSFER_FEE_E8S} : nat;
  decimals = opt (8 : nat8);
  max_memo_length = opt (80 : nat16);
  token_symbol = "KINIC";
  token_name = "Local KINIC";
  metadata = vec {};
  initial_balances = vec {
    record {
      record { owner = principal "${owner}"; subaccount = null };
      ${DEFAULT_INITIAL_BALANCE_E8S} : nat
    }
  };
  feature_flags = opt record { icrc2 = true };
  archive_options = record {
    num_blocks_to_archive = 1_000 : nat64;
    max_transactions_per_response = opt (100 : nat64);
    trigger_threshold = 2_000 : nat64;
    max_message_size_bytes = null;
    cycles_for_archive_creation = null;
    node_max_memory_size_bytes = null;
    controller_id = principal "${owner}";
    more_controller_ids = null
  };
  index_principal = null
} })
EOF

  if ! icp canister install "${canister_id}" \
    --wasm "${wasm_path}" \
    --mode "${install_mode}" \
    --args-file "${args_file}" \
    -e "${ICP_ENVIRONMENT}" \
    -y >/dev/null; then
    rm -f "${args_file}"
    return 1
  fi
  rm -f "${args_file}"
}

assert_icrc2_ledger() {
  local canister_id="$1"
  local standards
  standards="$(icp canister call "${canister_id}" icrc1_supported_standards '()' -e "${ICP_ENVIRONMENT}" -o candid)"
  if [[ "${standards}" != *'name = "ICRC-2"'* ]]; then
    echo "KINIC ledger ${canister_id} does not report ICRC-2 support" >&2
    exit 1
  fi
}

assert_identity_has_balance() {
  local canister_id="$1"
  local owner="$2"
  local balance
  balance="$(icp canister call "${canister_id}" icrc1_balance_of "(record { owner = principal \"${owner}\"; subaccount = null })" -e "${ICP_ENVIRONMENT}" -o candid)"
  if [[ "${balance}" == "(0 : nat)" ]]; then
    echo "current identity has zero local KINIC balance on ${canister_id}" >&2
    exit 1
  fi
}

require_unsigned_integer DEFAULT_INITIAL_BALANCE_E8S
require_unsigned_integer LEDGER_TRANSFER_FEE_E8S

OWNER_PRINCIPAL="$(current_identity_principal)"

if [[ -n "${KINIC_LEDGER_CANISTER_ID:-}" ]]; then
  if ! canister_exists "${KINIC_LEDGER_CANISTER_ID}"; then
    echo "KINIC_LEDGER_CANISTER_ID does not exist on ${ICP_ENVIRONMENT}: ${KINIC_LEDGER_CANISTER_ID}" >&2
    exit 1
  fi
  assert_icrc2_ledger "${KINIC_LEDGER_CANISTER_ID}"
  assert_identity_has_balance "${KINIC_LEDGER_CANISTER_ID}" "${OWNER_PRINCIPAL}"
  printf 'KINIC_LEDGER_CANISTER_ID=%s\n' "${KINIC_LEDGER_CANISTER_ID}"
  exit 0
fi

mkdir -p "${LEDGER_ID_DIR}"
if [[ -f "${LEDGER_ID_FILE}" ]]; then
  KINIC_LEDGER_CANISTER_ID="$(tr -d '[:space:]' <"${LEDGER_ID_FILE}")"
fi

LEDGER_WASM="$(resolve_ledger_wasm)"
INSTALL_MODE="reinstall"
if [[ -z "${KINIC_LEDGER_CANISTER_ID:-}" ]] || ! canister_exists "${KINIC_LEDGER_CANISTER_ID}"; then
  KINIC_LEDGER_CANISTER_ID="$(create_detached_ledger)"
  printf '%s\n' "${KINIC_LEDGER_CANISTER_ID}" >"${LEDGER_ID_FILE}"
  INSTALL_MODE="install"
elif ! canister_has_module "${KINIC_LEDGER_CANISTER_ID}" >/dev/null 2>&1; then
  INSTALL_MODE="install"
fi

echo "installing local KINIC ledger ${KINIC_LEDGER_CANISTER_ID} on ${ICP_ENVIRONMENT}" >&2
install_ledger "${KINIC_LEDGER_CANISTER_ID}" "${LEDGER_WASM}" "${OWNER_PRINCIPAL}" "${INSTALL_MODE}"
assert_icrc2_ledger "${KINIC_LEDGER_CANISTER_ID}"
assert_identity_has_balance "${KINIC_LEDGER_CANISTER_ID}" "${OWNER_PRINCIPAL}"

printf 'KINIC_LEDGER_CANISTER_ID=%s\n' "${KINIC_LEDGER_CANISTER_ID}"
