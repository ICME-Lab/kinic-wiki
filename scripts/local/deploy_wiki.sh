#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/local/deploy_wiki.sh
# What: Deploy the wiki canister locally with explicit billing init args.
# Why: Local billing tests need a stable ledger ID while production keeps explicit env validation.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ICP_ENVIRONMENT="${ICP_ENVIRONMENT:-local}"
KINIC_LEDGER_CANISTER_ID="${KINIC_LEDGER_CANISTER_ID:-73mez-iiaaa-aaaaq-aaasq-cai}"
SNS_GOVERNANCE_ID="${SNS_GOVERNANCE_ID:-}"

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

if [[ -z "${SNS_GOVERNANCE_ID}" ]]; then
  SNS_GOVERNANCE_ID="$(current_identity_principal)"
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
require_principal_env SNS_GOVERNANCE_ID

ARGS_FILE="$(mktemp "${TMPDIR:-/tmp}/wiki-local-billing-init.XXXXXX.did")"
trap 'rm -f "${ARGS_FILE}"' EXIT

cat >"${ARGS_FILE}" <<EOF
(record {
  kinic_ledger_canister_id = "${KINIC_LEDGER_CANISTER_ID}";
  sns_governance_id = "${SNS_GOVERNANCE_ID}";
  rate_numerator_e8s = 200 : nat64;
  rate_denominator_cycles = 1_000_000 : nat64;
  fixed_update_fee_e8s = 100 : nat64;
  min_update_balance_e8s = 10_000 : nat64;
})
EOF

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "local wiki billing init args generated for ${ICP_ENVIRONMENT}" >&2
  echo "KINIC_LEDGER_CANISTER_ID=${KINIC_LEDGER_CANISTER_ID}" >&2
  echo "SNS_GOVERNANCE_ID=${SNS_GOVERNANCE_ID}" >&2
  exit 0
fi

cd "${REPO_ROOT}"
icp deploy wiki -e "${ICP_ENVIRONMENT}" --args-file "${ARGS_FILE}" "$@"
