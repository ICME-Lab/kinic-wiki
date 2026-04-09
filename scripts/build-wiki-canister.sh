#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/build-wiki-canister.sh
# What: Build the release wasm artifact used by the canister CI job and deployment flow.
# Why: The canister target pulls in bundled sqlite C code, so wasm32-wasip1 builds need a WASI sysroot when running on Linux.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${REPO_ROOT}/target/wasm32-wasip1/release"
INPUT_WASM="${TARGET_DIR}/wiki_canister.wasm"
OUTPUT_WASM="${TARGET_DIR}/wiki_canister_nowasi.wasm"

# shellcheck source=./wasi-env.sh
source "${SCRIPT_DIR}/wasi-env.sh"
configure_wasi_cc_env

cargo build \
  --manifest-path "${REPO_ROOT}/Cargo.toml" \
  --package wiki-canister \
  --release \
  --locked \
  --target wasm32-wasip1

wasi2ic "${INPUT_WASM}" "${OUTPUT_WASM}"
cp "${OUTPUT_WASM}" "${ICP_WASM_OUTPUT_PATH}"

ic-wasm "${ICP_WASM_OUTPUT_PATH}" \
  -o "${ICP_WASM_OUTPUT_PATH}" \
  metadata candid:service \
  -f "${REPO_ROOT}/crates/wiki_canister/wiki.did" \
  -v public \
  --keep-name-section
