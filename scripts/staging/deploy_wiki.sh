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
STAGING_ORIGIN="${KINIC_VFS_STAGING_II_ORIGIN:-}"
DRY_RUN=0
DEPLOY_ARGS=()

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

ARGS_FILE="$(mktemp "${TMPDIR:-/tmp}/wiki-staging-cycles-init.XXXXXX.did")"
trap 'rm -f "${ARGS_FILE}"' EXIT

cat >"${ARGS_FILE}" <<EOF
(record {
  kinic_ledger_canister_id = "${KINIC_LEDGER_CANISTER_ID}";
  billing_authority_id = "${BILLING_AUTHORITY_ID}";
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
  exit 0
fi

cd "${REPO_ROOT}"
MAPPED_CANISTER_ID="$(icp canister status wiki -e staging --identity "${DEPLOY_IDENTITY}" --id-only)"
if [[ "${MAPPED_CANISTER_ID}" != "${EXPECTED_CANISTER_ID}" ]]; then
  echo "staging wiki mapping resolved to ${MAPPED_CANISTER_ID}, expected ${EXPECTED_CANISTER_ID}" >&2
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
