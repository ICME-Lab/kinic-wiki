#!/usr/bin/env bash
set -euo pipefail

# Where: .local/check.sh
# What: Run the same checks this repo expects in CI from a single local entrypoint.
# Why: Pre-commit hooks and manual verification should fail on the same build and lint conditions as GitHub Actions.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../scripts/wasi-env.sh
source "${REPO_ROOT}/scripts/wasi-env.sh"
configure_wasi_cc_env

cd "${REPO_ROOT}"

cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings

(
  cd plugins/kinic-wiki
  npm ci
  npm run check
)

ICP_WASM_OUTPUT_PATH="${TMPDIR:-/tmp}/wiki_canister.wasm" \
  bash scripts/build-wiki-canister.sh
