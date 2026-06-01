#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/local/deploy_wiki.sh
# What: Deploy the wiki canister to the project-local local-wiki environment with CreditsConfig.
# Why: The canister constructor requires CreditsConfig; no-arg install/reinstall is unsupported.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODE="${MODE:-auto}"

cd "$REPO_ROOT"

if [[ -z "${KINIC_LEDGER_CANISTER_ID:-}" ]]; then
  echo "KINIC_LEDGER_CANISTER_ID is required" >&2
  exit 1
fi

if [[ -z "${SNS_GOVERNANCE_ID:-}" ]]; then
  SNS_GOVERNANCE_ID="$(icp identity principal)"
  export SNS_GOVERNANCE_ID
fi

args="$("${REPO_ROOT}/scripts/deploy/wiki_credits_args.sh")"
icp deploy wiki -e local-wiki --mode "$MODE" --args "$args"
