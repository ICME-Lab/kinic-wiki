#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/mainnet/deploy_wiki.sh
# What: Deploy the wiki canister to mainnet with explicit credits init args.
# Why: Credits ledger and SNS principals are immutable after init, so placeholders must never reach production.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ANONYMOUS_PRINCIPAL="2vxsx-fae"

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
require_principal_env SNS_GOVERNANCE_ID

ARGS_FILE="$(mktemp "${TMPDIR:-/tmp}/wiki-credits-init.XXXXXX.did")"
trap 'rm -f "${ARGS_FILE}"' EXIT

cat >"${ARGS_FILE}" <<EOF
(record {
  kinic_ledger_canister_id = "${KINIC_LEDGER_CANISTER_ID}";
  sns_governance_id = "${SNS_GOVERNANCE_ID}";
  credits_per_kinic = 1_000 : nat64;
  cycles_per_credit = 1_000_000_000 : nat64;
  min_update_credits = 1 : nat64;
})
EOF

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "mainnet wiki credits init args validated" >&2
  exit 0
fi

cd "${REPO_ROOT}"
icp deploy wiki -e ic --args-file "${ARGS_FILE}" "$@"
