#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/build-wiki-canister.sh
# What: Build the release wasm artifact used by the canister CI job and deployment flow.
# Why: The canister target pulls in bundled sqlite C code, so wasm32-wasip1 builds need a WASI sysroot when running on Linux.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# Always emit wasm under the repo `target/` tree. Cursor/agent shells may set
# CARGO_TARGET_DIR to a sandbox cache, which would make cargo and wasi2ic disagree on paths.
unset CARGO_TARGET_DIR
TARGET_DIR="${REPO_ROOT}/target/wasm32-wasip1/release"
INPUT_WASM="${TARGET_DIR}/wiki_canister.wasm"
OUTPUT_WASM="${TARGET_DIR}/wiki_canister_nowasi.wasm"
# `icp deploy` sets this; standalone runs default to the repo artifact path.
ICP_WASM_OUTPUT_PATH="${ICP_WASM_OUTPUT_PATH:-${OUTPUT_WASM}}"

# shellcheck source=./wasi-env.sh
source "${SCRIPT_DIR}/wasi-env.sh"
configure_wasi_cc_env

EXTRA_FEATURES=""
case "${WIKI_CANISTER_DIAGNOSTIC_PROFILE:-baseline}" in
  baseline)
    ;;
  fts_disabled_for_bench)
    EXTRA_FEATURES="bench-disable-fts"
    ;;
  *)
    echo "unknown WIKI_CANISTER_DIAGNOSTIC_PROFILE: ${WIKI_CANISTER_DIAGNOSTIC_PROFILE}" >&2
    exit 1
    ;;
esac

build_cmd=(
  cargo build
  --manifest-path "${REPO_ROOT}/Cargo.toml"
  --package wiki-canister
  --release
  --locked
  --target wasm32-wasip1
)

if [[ -n "${EXTRA_FEATURES}" ]]; then
  build_cmd+=(--features "${EXTRA_FEATURES}")
fi

"${build_cmd[@]}"

wasi2ic "${INPUT_WASM}" "${OUTPUT_WASM}"
if [[ "${OUTPUT_WASM}" != "${ICP_WASM_OUTPUT_PATH}" ]]; then
  cp "${OUTPUT_WASM}" "${ICP_WASM_OUTPUT_PATH}"
fi

ic-wasm "${ICP_WASM_OUTPUT_PATH}" \
  -o "${ICP_WASM_OUTPUT_PATH}" \
  metadata candid:service \
  -f "${REPO_ROOT}/crates/wiki_canister/wiki.did" \
  -v public \
  --keep-name-section
