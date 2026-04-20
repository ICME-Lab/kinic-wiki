#!/usr/bin/env bash
set -euo pipefail

# Where: .local/check.sh
# What: Run the same checks this repo expects in CI from a single local entrypoint.
# Why: Pre-commit hooks and manual verification should fail on the same build and lint conditions as GitHub Actions.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLUGIN_DIR="${REPO_ROOT}/plugins/kinic-wiki"
PLUGIN_LOCKFILE="${PLUGIN_DIR}/package-lock.json"
PLUGIN_NODE_MODULES="${PLUGIN_DIR}/node_modules"
PLUGIN_LOCK_STAMP="${PLUGIN_NODE_MODULES}/.kinic-package-lock.sha256"

# shellcheck source=../scripts/wasi-env.sh
source "${REPO_ROOT}/scripts/wasi-env.sh"
configure_wasi_cc_env

plugin_lock_hash() {
  shasum -a 256 "${PLUGIN_LOCKFILE}" | awk '{print $1}'
}

ensure_plugin_dependencies() {
  local current_hash=""
  local installed_hash=""
  current_hash="$(plugin_lock_hash)"

  if [[ -d "${PLUGIN_NODE_MODULES}" ]] \
    && [[ -f "${PLUGIN_LOCK_STAMP}" ]] \
    && [[ -x "${PLUGIN_NODE_MODULES}/.bin/tsc" ]] \
    && [[ -x "${PLUGIN_NODE_MODULES}/.bin/eslint" ]] \
    && [[ -x "${PLUGIN_NODE_MODULES}/.bin/esbuild" ]]; then
    installed_hash="$(<"${PLUGIN_LOCK_STAMP}")"
    if [[ "${current_hash}" == "${installed_hash}" ]]; then
      return
    fi
  fi

  (
    cd "${PLUGIN_DIR}"
    npm ci
    printf '%s\n' "${current_hash}" > "${PLUGIN_LOCK_STAMP}"
  )
}

cd "${REPO_ROOT}"

cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings

ensure_plugin_dependencies
(
  cd "${PLUGIN_DIR}"
  npm run check
)

ICP_WASM_OUTPUT_PATH="${TMPDIR:-/tmp}/wiki_canister.wasm" \
  bash scripts/build-wiki-canister.sh
