#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/local/deploy_wiki.sh
# What: Deploy the wiki canister locally with explicit cycles billing init args.
# Why: Local cycles tests need a stable ledger ID while production keeps explicit env validation.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ICP_ENVIRONMENT="${ICP_ENVIRONMENT:-local}"
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

ARGS_FILE="$(mktemp "${TMPDIR:-/tmp}/wiki-local-cycles-init.XXXXXX.did")"
trap 'rm -f "${ARGS_FILE}"' EXIT

cat >"${ARGS_FILE}" <<EOF
(record {
  kinic_ledger_canister_id = "${KINIC_LEDGER_CANISTER_ID}";
  billing_authority_id = "${BILLING_AUTHORITY_ID}";
  cycles_per_kinic = 1_000 : nat64;
  min_update_cycles = 1 : nat64;
})
EOF

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "local wiki cycles init args generated for ${ICP_ENVIRONMENT}" >&2
  echo "KINIC_LEDGER_CANISTER_ID=${KINIC_LEDGER_CANISTER_ID}" >&2
  echo "BILLING_AUTHORITY_ID=${BILLING_AUTHORITY_ID}" >&2
  exit 0
fi

cd "${REPO_ROOT}"
icp deploy wiki -e "${ICP_ENVIRONMENT}" --args-file "${ARGS_FILE}" "$@"
