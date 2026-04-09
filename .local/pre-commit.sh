#!/usr/bin/env bash
set -euo pipefail

# Where: .local/pre-commit.sh
# What: Run fast local checks before creating a commit.
# Why: Commit hooks should catch obvious breakage without forcing a full release canister build on every commit.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

cargo fmt --all -- --check
cargo test --workspace --locked

(
  cd plugins/kinic-wiki
  npm run typecheck
  npm run test
  npm run lint
)
