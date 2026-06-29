#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/local/deploy_wiki.sh
# What: Deploy the wiki canister locally with explicit cycles billing init args.
# Why: Local cycles tests need a stable ledger ID while production keeps explicit env validation.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ICP_ENVIRONMENT="${ICP_ENVIRONMENT:-local-wiki}"
KINIC_LEDGER_CANISTER_ID="${KINIC_LEDGER_CANISTER_ID:-}"
BILLING_AUTHORITY_ID="${BILLING_AUTHORITY_ID:-}"

case "${ICP_ENVIRONMENT}" in
  local | local-wiki) ;;
  *)
    echo "ICP_ENVIRONMENT must be local or local-wiki for local deploy" >&2
    exit 1
    ;;
esac

current_identity_principal() {
  icp identity principal
}

if [[ -z "${BILLING_AUTHORITY_ID}" ]]; then
  BILLING_AUTHORITY_ID="$(current_identity_principal)"
fi

require_principal_env() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value}" ]]; then
    echo "${name} is required" >&2
    exit 1
  fi
  if [[ "${value}" =~ [[:space:]] ]]; then
    echo "${name} must not contain whitespace" >&2
    exit 1
  fi
}

require_principal_env KINIC_LEDGER_CANISTER_ID
require_principal_env BILLING_AUTHORITY_ID

deploy_mode_is_upgrade() {
  local previous=""
  for arg in "$@"; do
    if [[ "${arg}" == "--mode=upgrade" ]]; then
      return 0
    fi
    if [[ "${previous}" == "--mode" && "${arg}" == "upgrade" ]]; then
      return 0
    fi
    previous="${arg}"
  done
  return 1
}

check_no_archive_restore_databases() {
  local sql
  local output
  sql="SELECT json_object('count', COUNT(*)) FROM databases WHERE status IN ('archiving','archived','restoring') LIMIT 1"
  if ! output="$(icp canister call wiki query_index_sql_json "(\"${sql}\", 1 : nat32)" -e "${ICP_ENVIRONMENT}" -o candid)"; then
    echo "archive/restore preflight failed" >&2
    return 1
  fi
  if [[ "${output}" != *'\\"count\\":0'* && "${output}" != *'"count":0'* ]]; then
    echo "archive/restore preflight failed: archived, archiving, or restoring databases remain" >&2
    echo "${output}" >&2
    return 1
  fi
}

ARGS_FILE="$(mktemp "${TMPDIR:-/tmp}/wiki-local-cycles-init.XXXXXX.did")"
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
  echo "local wiki cycles init args generated for ${ICP_ENVIRONMENT}" >&2
  echo "KINIC_LEDGER_CANISTER_ID=${KINIC_LEDGER_CANISTER_ID}" >&2
  echo "BILLING_AUTHORITY_ID=${BILLING_AUTHORITY_ID}" >&2
  exit 0
fi

cd "${REPO_ROOT}"
export ICP_ENVIRONMENT
export KINIC_VFS_LOCAL_II_ORIGINS=1
if deploy_mode_is_upgrade "$@"; then
  check_no_archive_restore_databases
fi
icp deploy wiki -e "${ICP_ENVIRONMENT}" --args-file "${ARGS_FILE}" "$@"
