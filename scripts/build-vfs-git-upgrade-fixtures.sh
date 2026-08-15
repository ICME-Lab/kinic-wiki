#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/build-vfs-git-upgrade-fixtures.sh
# What: Build the fixed v002 and proposed v003 Wasms used by the PocketIC upgrade test.
# Why: Upgrade rollback is only meaningful when the previous and proposed artifacts are distinct.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
V002_REV="${VFS_V002_REV:-cc41c919126724657c6c26636f46c43688d0ab8f}"
OUTPUT_DIR="${REPO_ROOT}/target/pocketic/vfs-git-upgrade"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kinic-v002.XXXXXX")"

cleanup() {
  rm -rf "${TEMP_ROOT}"
}
trap cleanup EXIT

mkdir -p "${OUTPUT_DIR}"
git -C "${REPO_ROOT}" archive "${V002_REV}" | tar -x -C "${TEMP_ROOT}"

ICP_WASM_OUTPUT_PATH="${OUTPUT_DIR}/vfs-v002.wasm" \
  bash "${TEMP_ROOT}/scripts/build-vfs-canister.sh"

VFS_CANISTER_DIAGNOSTIC_PROFILE=baseline \
ICP_WASM_OUTPUT_PATH="${OUTPUT_DIR}/vfs-v003.wasm" \
  bash "${REPO_ROOT}/scripts/build-vfs-canister.sh"

VFS_CANISTER_DIAGNOSTIC_PROFILE=migration-failpoint \
ICP_WASM_OUTPUT_PATH="${OUTPUT_DIR}/vfs-v003-migration-failpoint.wasm" \
  bash "${REPO_ROOT}/scripts/build-vfs-canister.sh"
