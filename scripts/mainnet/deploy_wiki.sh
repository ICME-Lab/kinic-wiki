#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/mainnet/deploy_wiki.sh
# What: Deploy the wiki canister to mainnet with cycles billing init args.
# Why: Cycles ledger and billing authority principals are immutable after init, so init values must be concrete deploy-time principals.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ANONYMOUS_PRINCIPAL="2vxsx-fae"
KINIC_LEDGER_CANISTER_ID="${KINIC_LEDGER_CANISTER_ID:-}"
BILLING_AUTHORITY_ID="${BILLING_AUTHORITY_ID:-}"
CURRENT_CYCLES_BILLING_CONFIG=""

load_current_cycles_billing_config() {
  if [[ -n "${CURRENT_CYCLES_BILLING_CONFIG}" ]]; then
    return 0
  fi

  if ! CURRENT_CYCLES_BILLING_CONFIG="$(cd "${REPO_ROOT}" && icp canister call wiki get_cycles_billing_config '()' -e ic -o candid 2>/dev/null)"; then
    echo "failed to read current mainnet cycles billing config; set KINIC_LEDGER_CANISTER_ID and BILLING_AUTHORITY_ID explicitly" >&2
    return 1
  fi

  if [[ "${CURRENT_CYCLES_BILLING_CONFIG}" != *"Ok = record"* ]]; then
    echo "current mainnet cycles billing config did not return Ok; set KINIC_LEDGER_CANISTER_ID and BILLING_AUTHORITY_ID explicitly" >&2
    return 1
  fi

  return 0
}

extract_current_config_text() {
  local field="$1"
  load_current_cycles_billing_config || return 1
  awk -v field="${field}" -F'"' '$0 ~ field { print $2; found = 1; exit } END { if (!found) exit 1 }' <<<"${CURRENT_CYCLES_BILLING_CONFIG}"
}

resolve_principal_env() {
  local name="$1"
  local field="$2"
  local value
  if [[ -n "${!name:-}" ]]; then
    return 0
  fi
  if ! value="$(extract_current_config_text "${field}")" || [[ -z "${value}" ]]; then
    echo "${name} is required and could not be resolved from the current mainnet cycles billing config" >&2
    return 1
  fi
  printf -v "${name}" '%s' "${value}"
  export "${name}"
}

require_principal_env() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value}" ]]; then
    echo "${name} is required" >&2
    return 1
  fi
  if [[ "${value}" == "${ANONYMOUS_PRINCIPAL}" ]]; then
    echo "${name} must not be anonymous" >&2
    return 1
  fi
  if [[ "${value}" =~ [[:space:]] ]]; then
    echo "${name} must not contain whitespace" >&2
    return 1
  fi
}

resolve_principal_env KINIC_LEDGER_CANISTER_ID kinic_ledger_canister_id
resolve_principal_env BILLING_AUTHORITY_ID billing_authority_id
require_principal_env KINIC_LEDGER_CANISTER_ID
require_principal_env BILLING_AUTHORITY_ID

ARGS_FILE="$(mktemp "${TMPDIR:-/tmp}/wiki-cycles-init.XXXXXX.did")"
trap 'rm -f "${ARGS_FILE}"' EXIT

cat >"${ARGS_FILE}" <<EOF
(record {
  kinic_ledger_canister_id = "${KINIC_LEDGER_CANISTER_ID}";
  billing_authority_id = "${BILLING_AUTHORITY_ID}";
  top_up = record {
    enabled = true;
    launcher_principal = "xfug4-5qaaa-aaaak-afowa-cai";
    threshold_cycles = 2_000_000_000_000 : nat;
  };
  cycles_per_kinic = 234_500_000_000 : nat64;
  min_update_cycles = 1_000_000 : nat64;
})
EOF

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "mainnet wiki cycles init args validated" >&2
  echo "KINIC_LEDGER_CANISTER_ID=${KINIC_LEDGER_CANISTER_ID}" >&2
  echo "BILLING_AUTHORITY_ID=${BILLING_AUTHORITY_ID}" >&2
  exit 0
fi

cd "${REPO_ROOT}"
unset KINIC_VFS_LOCAL_II_ORIGINS
icp deploy wiki -e ic --args-file "${ARGS_FILE}" "$@"
