#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/build-vfs-canister-canbench.sh
# What: Build the benchmarkable canister wasm that canbench executes.
# Why: The normal build path uses wasi2ic + ic-wasm, and benchmarks must compile the same canister with the canbench feature enabled.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${REPO_ROOT}/target/wasm32-wasip1/release"
INPUT_WASM="${TARGET_DIR}/vfs_canister.wasm"
OUTPUT_WASM="${REPO_ROOT}/target/canbench/vfs_canister_canbench.wasm"

# shellcheck source=./wasi-env.sh
source "${SCRIPT_DIR}/wasi-env.sh"
configure_wasi_cc_env

mkdir -p "$(dirname "${OUTPUT_WASM}")"

cargo build \
  --manifest-path "${REPO_ROOT}/Cargo.toml" \
  --package vfs-canister \
  --release \
  --locked \
  --target wasm32-wasip1 \
  --features canbench-rs

wasi2ic "${INPUT_WASM}" "${OUTPUT_WASM}"
ic-wasm "${OUTPUT_WASM}" \
  -o "${OUTPUT_WASM}" \
  metadata candid:service \
  -f "${REPO_ROOT}/crates/vfs_canister/vfs.did" \
  -v public \
  --keep-name-section
