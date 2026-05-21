#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/build-vfs-canister.sh
# What: Build the release wasm artifact used by the canister CI job and deployment flow.
# Why: The canister uses ic-sqlite-vfs directly, so the IC artifact is built as wasm32-unknown-unknown.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# Always emit wasm under the repo `target/` tree. Cursor/agent shells may set
# CARGO_TARGET_DIR to a sandbox cache, which would move the deployment artifact.
unset CARGO_TARGET_DIR
TARGET_DIR="${REPO_ROOT}/target/wasm32-unknown-unknown/release"
INPUT_WASM="${TARGET_DIR}/vfs_canister.wasm"
OUTPUT_WASM="${INPUT_WASM}"
# `icp deploy` sets this; standalone runs default to the repo artifact path.
ICP_WASM_OUTPUT_PATH="${ICP_WASM_OUTPUT_PATH:-${OUTPUT_WASM}}"

EXTRA_FEATURES=""
case "${VFS_CANISTER_DIAGNOSTIC_PROFILE:-baseline}" in
  baseline)
    ;;
  *)
    echo "unknown VFS_CANISTER_DIAGNOSTIC_PROFILE: ${VFS_CANISTER_DIAGNOSTIC_PROFILE}" >&2
    exit 1
    ;;
esac

build_cmd=(
  cargo build
  --manifest-path "${REPO_ROOT}/Cargo.toml"
  --package vfs-canister
  --release
  --locked
  --target wasm32-unknown-unknown
)

if [[ -n "${EXTRA_FEATURES}" ]]; then
  build_cmd+=(--features "${EXTRA_FEATURES}")
fi

maybe_dump_wasm_sections() {
  local label="$1"
  local wasm_path="$2"
  if [[ "${VFS_CANISTER_WASM_DEBUG_SECTIONS:-0}" != "1" ]]; then
    return
  fi
  if ! command -v wasm-tools >/dev/null 2>&1; then
    return
  fi
  echo "wasm section dump (${label}): ${wasm_path}" >&2
  wasm-tools objdump "${wasm_path}" >&2
}

"${build_cmd[@]}"

maybe_dump_wasm_sections "cargo-build output" "${INPUT_WASM}"
if [[ "${OUTPUT_WASM}" != "${ICP_WASM_OUTPUT_PATH}" ]]; then
  cp "${OUTPUT_WASM}" "${ICP_WASM_OUTPUT_PATH}"
fi

ic-wasm "${ICP_WASM_OUTPUT_PATH}" \
  -o "${ICP_WASM_OUTPUT_PATH}" \
  metadata candid:service \
  -f "${REPO_ROOT}/crates/vfs_canister/vfs.did" \
  -v public \
  --keep-name-section
