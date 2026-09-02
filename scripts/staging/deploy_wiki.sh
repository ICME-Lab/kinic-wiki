#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/staging/deploy_wiki.sh
# What: Install or upgrade the wiki canister in the isolated IC staging environment.
# Why: Staging must use a fixed canister, billing authority, and II origin without production data.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EXPECTED_CANISTER_ID="3ryrw-kyaaa-aaaaf-qgxpq-cai"
DEPLOY_IDENTITY="llm-wiki-mainnet"
KINIC_LEDGER_CANISTER_ID="73mez-iiaaa-aaaaq-aaasq-cai"
BILLING_AUTHORITY_ID="r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae"
IAP_AUTHORITY_ID="${IAP_AUTHORITY_ID:-}"
STAGING_ORIGIN="${KINIC_VFS_STAGING_II_ORIGIN:-}"
DRY_RUN=0
DEPLOY_ARGS=()
MIN_UPGRADE_CYCLES="${KINIC_VFS_STAGING_MIN_UPGRADE_CYCLES:-50000000000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      DEPLOY_ARGS+=("$1")
      shift
      ;;
  esac
done

if ! [[ "${STAGING_ORIGIN}" =~ ^https://[a-z0-9.-]+$ ]]; then
  echo "KINIC_VFS_STAGING_II_ORIGIN must be an HTTPS origin without a path" >&2
  exit 1
fi

if [[ -z "${IAP_AUTHORITY_ID}" ]]; then
  echo "IAP_AUTHORITY_ID is required for staging deploys" >&2
  exit 1
fi
if ! didc encode -t '(principal)' "(principal \"${IAP_AUTHORITY_ID}\")" >/dev/null 2>&1; then
  echo "IAP_AUTHORITY_ID must be a valid principal" >&2
  exit 1
fi

ARGS_FILE="$(mktemp "${TMPDIR:-/tmp}/wiki-staging-cycles-init.XXXXXX.did")"
trap 'rm -f "${ARGS_FILE}"' EXIT

cat >"${ARGS_FILE}" <<EOF
(record {
  kinic_ledger_canister_id = "${KINIC_LEDGER_CANISTER_ID}";
  billing_authority_id = "${BILLING_AUTHORITY_ID}";
  iap_authority_id = "${IAP_AUTHORITY_ID}";
  top_up = record {
    enabled = false;
    launcher_principal = "xfug4-5qaaa-aaaak-afowa-cai";
    threshold_cycles = 2_000_000_000_000 : nat;
  };
  cycles_per_kinic = 234_500_000_000 : nat64;
  min_update_cycles = 1_000_000 : nat64;
})
EOF

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "staging wiki deploy validated" >&2
  echo "CANISTER_ID=${EXPECTED_CANISTER_ID}" >&2
  echo "KINIC_VFS_STAGING_II_ORIGIN=${STAGING_ORIGIN}" >&2
  echo "IAP_AUTHORITY_ID=${IAP_AUTHORITY_ID}" >&2
  exit 0
fi

cd "${REPO_ROOT}"
MAPPED_CANISTER_ID="$(icp canister status wiki -e staging --identity "${DEPLOY_IDENTITY}" --id-only)"
if [[ "${MAPPED_CANISTER_ID}" != "${EXPECTED_CANISTER_ID}" ]]; then
  echo "staging wiki mapping resolved to ${MAPPED_CANISTER_ID}, expected ${EXPECTED_CANISTER_ID}" >&2
  exit 1
fi

PRE_DEPLOY_STATUS="$(icp canister status wiki -e staging --identity "${DEPLOY_IDENTITY}" --json)"
echo "staging status before upgrade: ${PRE_DEPLOY_STATUS}" >&2
CURRENT_CYCLES="$(printf '%s' "${PRE_DEPLOY_STATUS}" | tr -d '_' | sed -nE 's/.*"cycles":"?([0-9]+)"?.*/\1/p')"
if [[ -z "${CURRENT_CYCLES}" || "${CURRENT_CYCLES}" -lt "${MIN_UPGRADE_CYCLES}" ]]; then
  echo "staging canister has insufficient or unreadable cycles for upgrade; no top-up was attempted" >&2
  exit 1
fi

unset KINIC_VFS_LOCAL_II_ORIGINS
if [[ "${#DEPLOY_ARGS[@]}" -gt 0 ]]; then
  ICP_ENVIRONMENT=staging KINIC_VFS_STAGING_II_ORIGIN="${STAGING_ORIGIN}" \
    icp deploy wiki -e staging --identity "${DEPLOY_IDENTITY}" --args-file "${ARGS_FILE}" "${DEPLOY_ARGS[@]}"
else
  ICP_ENVIRONMENT=staging KINIC_VFS_STAGING_II_ORIGIN="${STAGING_ORIGIN}" \
    icp deploy wiki -e staging --identity "${DEPLOY_IDENTITY}" --args-file "${ARGS_FILE}"
fi


POST_DEPLOY_STATUS="$(icp canister status wiki -e staging --identity "${DEPLOY_IDENTITY}" --json)"
echo "staging status after upgrade: ${POST_DEPLOY_STATUS}" >&2
BILLING_CONFIG="$(icp canister call wiki get_cycles_billing_config '()' --query -e staging --identity "${DEPLOY_IDENTITY}" --output candid)"
echo "staging billing config after upgrade: ${BILLING_CONFIG}" >&2
if [[ "${BILLING_CONFIG}" != *"${IAP_AUTHORITY_ID}"* ]]; then
  echo "staging billing config does not contain the expected IAP authority" >&2
  exit 1
fi
