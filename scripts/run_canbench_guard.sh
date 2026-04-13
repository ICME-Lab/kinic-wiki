#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/run_canbench_guard.sh
# What: Resolve fixed canbench and PocketIC binaries before running canbench.
# Why: canbench 0.4.1 requires pocket-ic-server 10.0.0, so we fail fast instead of allowing a runtime mismatch and fallback download.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXPECTED_RUNTIME_VERSION="pocket-ic-server 10.0.0"

resolve_canbench_bin() {
  if [[ -x "${REPO_ROOT}/.canbench-tools/bin/canbench" ]]; then
    printf '%s\n' "${REPO_ROOT}/.canbench-tools/bin/canbench"
    return 0
  fi

  if command -v canbench >/dev/null 2>&1; then
    command -v canbench
    return 0
  fi

  echo "canbench binary not found. Expected ./.canbench-tools/bin/canbench or canbench on PATH." >&2
  return 1
}

resolve_runtime_bin() {
  local -a candidates=()

  candidates+=(
    "${REPO_ROOT}/.canbench/pocket-ic"
    "${REPO_ROOT}/pocket-ic"
    "${REPO_ROOT}/crates/evm-rpc-e2e/pocket-ic"
  )
  if [[ -n "${POCKET_IC_BIN:-}" ]]; then
    candidates+=("${POCKET_IC_BIN}")
  fi

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  echo "PocketIC runtime not found. Set POCKET_IC_BIN or place pocket-ic at ./.canbench/pocket-ic, ./pocket-ic, or ./crates/evm-rpc-e2e/pocket-ic." >&2
  return 1
}

CANBENCH_BIN="$(resolve_canbench_bin)"
RUNTIME_BIN="$(resolve_runtime_bin)"
RUNTIME_VERSION="$("${RUNTIME_BIN}" --version)"

if [[ "${RUNTIME_VERSION}" != "${EXPECTED_RUNTIME_VERSION}" ]]; then
  echo "PocketIC runtime version mismatch: got '${RUNTIME_VERSION}', expected '${EXPECTED_RUNTIME_VERSION}'." >&2
  echo "Use POCKET_IC_BIN or ./.canbench/pocket-ic with pocket-ic-server 10.0.0." >&2
  exit 1
fi

echo "Using canbench binary: ${CANBENCH_BIN}"
echo "Using PocketIC runtime: ${RUNTIME_BIN}"
echo "Using PocketIC version: ${RUNTIME_VERSION}"

exec "${CANBENCH_BIN}" --runtime-path "${RUNTIME_BIN}" --persist --show-summary "$@"
