#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/mainnet/deploy_wiki.sh
# What: Preflight and explicitly upgrade the live wiki canister with the IAP backport.
# Why: Mainnet state must be preserved and the upgrade must stop if live state drifted.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
EXPECTED_BRANCH="feat/iap-mainnet-backport"
EXPECTED_BASE_COMMIT="83bbb0b6"
ENVIRONMENT="mainnet-sev"
CANISTER_ID="6emaw-iyaaa-aaaay-aacka-cai"
EXPECTED_MODULE_HASH="0x184c5eea473b84fd12346129f10ee41fb2580ff7cc1a90997a2ea0e5bb461c0a"
CONTROLLER_ID="r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae"
LEDGER_ID="73mez-iiaaa-aaaaq-aaasq-cai"
IAP_AUTHORITY_ID="hcums-tc6dw-saet6-tkznz-mkldy-lwq47-2pehv-uoq3u-6a22c-mqfsh-5qe"
DEPLOY_IDENTITY="${DEPLOY_IDENTITY:-}"
EXECUTE=0

case "${1:-}" in
  "") ;;
  --execute) EXECUTE=1 ;;
  --reinstall|--mode=reinstall|--mode)
    echo "reinstall and caller-selected install modes are forbidden for mainnet" >&2
    exit 1
    ;;
  *)
    echo "usage: $0 [--execute]" >&2
    exit 1
    ;;
esac
if [[ $# -gt 1 ]]; then
  echo "usage: $0 [--execute]" >&2
  exit 1
fi

cd "${REPO_ROOT}"
if [[ "$(git branch --show-current)" != "${EXPECTED_BRANCH}" ]]; then
  echo "mainnet upgrade must run from ${EXPECTED_BRANCH}" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "${EXPECTED_BASE_COMMIT}" HEAD; then
  echo "HEAD does not descend from verified base ${EXPECTED_BASE_COMMIT}" >&2
  exit 1
fi
if [[ "${EXECUTE}" == "1" && -n "$(git status --porcelain)" ]]; then
  echo "mainnet upgrade requires a clean worktree" >&2
  exit 1
fi

identity_args=()
if [[ -n "${DEPLOY_IDENTITY}" ]]; then
  identity_args+=(--identity "${DEPLOY_IDENTITY}")
fi

status_json="$(icp canister status wiki -e "${ENVIRONMENT}" --json ${identity_args[@]+"${identity_args[@]}"})"
STATUS_JSON="${status_json}" node - <<'NODE'
const status = JSON.parse(process.env.STATUS_JSON);
const expected = {
  id: "6emaw-iyaaa-aaaay-aacka-cai",
  moduleHash: "0x184c5eea473b84fd12346129f10ee41fb2580ff7cc1a90997a2ea0e5bb461c0a",
  controller: "r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae",
};
if (status.id !== expected.id) throw new Error(`unexpected canister id: ${status.id}`);
if (status.module_hash !== expected.moduleHash) {
  throw new Error(`mainnet module hash drifted: ${status.module_hash}`);
}
if (
  status.settings?.controllers?.length !== 1 ||
  status.settings.controllers[0] !== expected.controller
) {
  throw new Error(`unexpected controllers: ${status.settings?.controllers}`);
}
NODE

billing_config="$(
  icp canister call wiki get_cycles_billing_config '()' \
    --query -e "${ENVIRONMENT}" --output candid ${identity_args[@]+"${identity_args[@]}"}
)"
for expected in \
  "billing_authority_id = \"${CONTROLLER_ID}\"" \
  "kinic_ledger_canister_id = \"${LEDGER_ID}\"" \
  "enabled = true" \
  "threshold_cycles = 2_000_000_000_000 : nat" \
  "launcher_principal = \"xfug4-5qaaa-aaaak-afowa-cai\"" \
  "cycles_per_kinic = 234_500_000_000 : nat64" \
  "min_update_cycles = 1_000_000 : nat64"
do
  if [[ "${billing_config}" != *"${expected}"* ]]; then
    echo "live billing config mismatch: missing ${expected}" >&2
    exit 1
  fi
done

node scripts/check-mainnet-candid-compat.mjs
ICP_ENVIRONMENT="${ENVIRONMENT}" scripts/build-vfs-canister.sh

args_file="$(mktemp "${TMPDIR:-/tmp}/wiki-iap-upgrade.XXXXXX.did")"
trap 'rm -f "${args_file}"' EXIT
cat >"${args_file}" <<EOF
(record {
  kinic_ledger_canister_id = "${LEDGER_ID}";
  billing_authority_id = "${CONTROLLER_ID}";
  iap_authority_id = opt "${IAP_AUTHORITY_ID}";
  top_up = record {
    enabled = true;
    launcher_principal = "xfug4-5qaaa-aaaak-afowa-cai";
    threshold_cycles = 2_000_000_000_000 : nat;
  };
  cycles_per_kinic = 234_500_000_000 : nat64;
  min_update_cycles = 1_000_000 : nat64;
})
EOF
didc encode -d crates/vfs_canister/vfs.did -t '(CyclesBillingConfig)' "$(<"${args_file}")" >/dev/null

if [[ "${EXECUTE}" != "1" ]]; then
  echo "mainnet IAP upgrade preflight: PASS"
  echo "No snapshot or deployment was performed. Re-run with --execute after review."
  exit 0
fi

if [[ "${CONFIRM_MAINNET_IAP_UPGRADE:-}" != "${CANISTER_ID}" ]]; then
  echo "set CONFIRM_MAINNET_IAP_UPGRADE=${CANISTER_ID} to authorize the upgrade" >&2
  exit 1
fi

snapshot_id="$(icp canister snapshot create wiki -e "${ENVIRONMENT}" -q ${identity_args[@]+"${identity_args[@]}"})"
snapshot_log_dir="${REPO_ROOT}/.local/mainnet-snapshots"
mkdir -p "${snapshot_log_dir}"
snapshot_log="${snapshot_log_dir}/iap-upgrade-$(date -u +%Y%m%dT%H%M%SZ).txt"
{
  echo "canister_id=${CANISTER_ID}"
  echo "pre_upgrade_module_hash=${EXPECTED_MODULE_HASH}"
  echo "snapshot_id=${snapshot_id}"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"${snapshot_log}"
chmod 600 "${snapshot_log}"
echo "snapshot_id=${snapshot_id}"
echo "snapshot_record=${snapshot_log}"

unset KINIC_VFS_LOCAL_II_ORIGINS KINIC_VFS_STAGING_II_ORIGIN
icp deploy wiki -e "${ENVIRONMENT}" --mode upgrade \
  --args-file "${args_file}" ${identity_args[@]+"${identity_args[@]}"}

echo "mainnet IAP upgrade completed; verify migration, existing operations, and grant authorization before enabling Worker fulfillment"
