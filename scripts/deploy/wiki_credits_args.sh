#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/deploy/wiki_credits_args.sh
# What: Emit the Candid CreditsConfig tuple used by wiki canister install/upgrade.
# Why: Fresh install requires explicit ledger/governance config, so deploy scripts share one source.

ANONYMOUS_PRINCIPAL="2vxsx-fae"

required_principal() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    echo "${name} is required" >&2
    exit 1
  fi
  if [[ "$value" == "$ANONYMOUS_PRINCIPAL" ]]; then
    echo "${name} must not be anonymous" >&2
    exit 1
  fi
  printf '%s' "$value"
}

positive_u64() {
  local name="$1"
  local default="$2"
  local value="${!name:-$default}"
  if [[ ! "$value" =~ ^[0-9]+$ || "$value" == "0" ]]; then
    echo "${name} must be a positive integer" >&2
    exit 1
  fi
  printf '%s' "$value"
}

ledger="$(required_principal KINIC_LEDGER_CANISTER_ID)"
governance="$(required_principal SNS_GOVERNANCE_ID)"
credits_per_kinic="$(positive_u64 CREDITS_PER_KINIC 1000)"
min_update_credits="$(positive_u64 MIN_UPDATE_CREDITS 1)"

printf '(record { kinic_ledger_canister_id = "%s"; sns_governance_id = "%s"; credits_per_kinic = %s : nat64; min_update_credits = %s : nat64 })\n' \
  "$ledger" \
  "$governance" \
  "$credits_per_kinic" \
  "$min_update_credits"
