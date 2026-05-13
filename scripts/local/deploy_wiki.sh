#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/local/deploy_wiki.sh
# What: Deploy the wiki canister locally with explicit placeholder billing init args.
# Why: Production must not inherit local anonymous placeholder principals from icp.yaml.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ICP_ENVIRONMENT="${ICP_ENVIRONMENT:-local}"

case "${ICP_ENVIRONMENT}" in
  local | local-wiki) ;;
  *)
    echo "ICP_ENVIRONMENT must be local or local-wiki for local placeholder deploy" >&2
    exit 1
    ;;
esac

ARGS_FILE="$(mktemp "${TMPDIR:-/tmp}/wiki-local-billing-init.XXXXXX.did")"
trap 'rm -f "${ARGS_FILE}"' EXIT

cat >"${ARGS_FILE}" <<'EOF'
(record {
  kinic_ledger_canister_id = "2vxsx-fae";
  sns_governance_id = "2vxsx-fae";
  rate_numerator_e8s = 200 : nat64;
  rate_denominator_cycles = 1_000_000 : nat64;
  fixed_update_fee_e8s = 100 : nat64;
  min_update_balance_e8s = 10_000 : nat64;
  min_initial_deposit_e8s = 1_000_000 : nat64;
})
EOF

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "local wiki billing init args generated for ${ICP_ENVIRONMENT}" >&2
  exit 0
fi

cd "${REPO_ROOT}"
icp deploy wiki -e "${ICP_ENVIRONMENT}" --args-file "${ARGS_FILE}" "$@"
