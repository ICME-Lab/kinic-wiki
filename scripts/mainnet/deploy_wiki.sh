#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/mainnet/deploy_wiki.sh
# What: Deploy the wiki canister to mainnet with cycles billing init args.
# Why: Cycles ledger and billing authority principals are immutable after init, so init values must be concrete deploy-time principals.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ANONYMOUS_PRINCIPAL="2vxsx-fae"
BILLING_AUTHORITY_ID="${BILLING_AUTHORITY_ID:-}"

current_identity_principal() {
  icp identity principal
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

require_principal_env KINIC_LEDGER_CANISTER_ID

if [[ -z "${BILLING_AUTHORITY_ID}" ]]; then
  BILLING_AUTHORITY_ID="$(current_identity_principal)"
fi

require_principal_env BILLING_AUTHORITY_ID

ARGS_FILE="$(mktemp "${TMPDIR:-/tmp}/wiki-cycles-init.XXXXXX.did")"
trap 'rm -f "${ARGS_FILE}"' EXIT

cat >"${ARGS_FILE}" <<EOF
(record {
  kinic_ledger_canister_id = "${KINIC_LEDGER_CANISTER_ID}";
  billing_authority_id = "${BILLING_AUTHORITY_ID}";
  cycles_per_kinic = 234_500_000_000 : nat64;
  min_update_cycles = 1_000_000 : nat64;
})
EOF

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "mainnet wiki cycles init args validated" >&2
  echo "BILLING_AUTHORITY_ID=${BILLING_AUTHORITY_ID}" >&2
  exit 0
fi

cd "${REPO_ROOT}"
icp deploy wiki -e ic --args-file "${ARGS_FILE}" "$@"
