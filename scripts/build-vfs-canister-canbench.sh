#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/build-vfs-canister-canbench.sh
# What: Build the benchmarkable canister wasm that canbench executes.
# Why: Benchmarks should compile the same wasm32-unknown-unknown canister artifact with canbench enabled.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${REPO_ROOT}/target/wasm32-unknown-unknown/release"
INPUT_WASM="${TARGET_DIR}/vfs_canister.wasm"
OUTPUT_WASM="${REPO_ROOT}/target/canbench/vfs_canister_canbench.wasm"

mkdir -p "$(dirname "${OUTPUT_WASM}")"

cargo build \
  --manifest-path "${REPO_ROOT}/Cargo.toml" \
  --package vfs-canister \
  --release \
  --locked \
  --target wasm32-unknown-unknown \
  --features canbench-rs

cp "${INPUT_WASM}" "${OUTPUT_WASM}"
ic-wasm "${OUTPUT_WASM}" \
  -o "${OUTPUT_WASM}" \
  metadata candid:service \
  -f "${REPO_ROOT}/crates/vfs_canister/vfs.did" \
  -v public \
  --keep-name-section
