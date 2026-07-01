#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/mainnet/deploy_wiki.sh
# What: Deploy the wiki canister to the fresh mainnet SEV environment.
# Why: Schema reset makes old-mainnet upgrades unsupported; fresh installs require explicit billing principals.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ANONYMOUS_PRINCIPAL="2vxsx-fae"
KINIC_LEDGER_CANISTER_ID="${KINIC_LEDGER_CANISTER_ID:-}"
BILLING_AUTHORITY_ID="${BILLING_AUTHORITY_ID:-}"
DEPLOY_ENVIRONMENT="${ICP_ENVIRONMENT:-mainnet-sev}"
DRY_RUN=0
DEPLOY_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --environment|-e)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "$1 requires an environment name" >&2
        exit 1
      fi
      DEPLOY_ENVIRONMENT="$2"
      shift 2
      ;;
    --environment=*)
      DEPLOY_ENVIRONMENT="${1#--environment=}"
      shift
      ;;
    *)
      DEPLOY_ARGS+=("$1")
      shift
      ;;
  esac
done

require_mainnet_sev_environment() {
  if [[ "${DEPLOY_ENVIRONMENT}" != "mainnet-sev" ]]; then
    echo "DEPLOY_ENVIRONMENT=${DEPLOY_ENVIRONMENT} is unsupported; this wrapper deploys fresh mainnet-sev only" >&2
    return 1
  fi
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

require_mainnet_sev_environment
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

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "${DEPLOY_ENVIRONMENT} wiki cycles init args validated" >&2
  echo "ICP_ENVIRONMENT=${DEPLOY_ENVIRONMENT}" >&2
  echo "KINIC_LEDGER_CANISTER_ID=${KINIC_LEDGER_CANISTER_ID}" >&2
  echo "BILLING_AUTHORITY_ID=${BILLING_AUTHORITY_ID}" >&2
  exit 0
fi

cd "${REPO_ROOT}"
unset KINIC_VFS_LOCAL_II_ORIGINS
if [[ "${#DEPLOY_ARGS[@]}" -gt 0 ]]; then
  icp deploy wiki -e "${DEPLOY_ENVIRONMENT}" --args-file "${ARGS_FILE}" "${DEPLOY_ARGS[@]}"
else
  icp deploy wiki -e "${DEPLOY_ENVIRONMENT}" --args-file "${ARGS_FILE}"
fi
