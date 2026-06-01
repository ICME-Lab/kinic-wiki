#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/mainnet/deploy_wiki.sh
# What: Deploy the wiki canister to mainnet with explicit CreditsConfig.
# Why: Production ledger/governance principals are fixed at init and must come from deploy env.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MODE="${MODE:-auto}"

cd "$REPO_ROOT"

args="$("${REPO_ROOT}/scripts/deploy/wiki_credits_args.sh")"
icp deploy wiki -e ic --mode "$MODE" --args "$args"
