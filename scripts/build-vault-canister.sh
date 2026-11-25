#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$TASK_ROOT"
if [[ -n "${VAULT_LOCAL_ORIGIN:-}${VAULT_LOCAL_HOST:-}${VAULT_LOCAL_II:-}${VAULT_LOCAL_WIKI_ORIGIN:-}${VAULT_LOCAL_NATIVE_CALLBACK:-}${VAULT_LOCAL_EXTENSION_ORIGIN:-}" && "${ICP_ENVIRONMENT:-}" != "local-vault" ]]; then
  echo 'Local Vault origins require ICP_ENVIRONMENT=local-vault' >&2
  exit 1
fi
if [[ "${ICP_ENVIRONMENT:-}" != "local-vault" && -n "${RUSTFLAGS:-}${CARGO_ENCODED_RUSTFLAGS:-}" ]]; then
  echo 'Production Vault builds require default compiler flags' >&2
  exit 1
fi
pnpm --config.verifyDepsBeforeRun=false --config.managePackageManagerVersions=false --dir vaultbrowser build
cargo build --package vault-canister --features embedded-assets --release --locked --target wasm32-unknown-unknown
TASK_WASM="$TASK_ROOT/target/wasm32-unknown-unknown/release/vault_canister.wasm"
TASK_OUTPUT="${ICP_WASM_OUTPUT_PATH:-$TASK_WASM}"
if [[ "$TASK_OUTPUT" != "$TASK_WASM" ]]; then cp "$TASK_WASM" "$TASK_OUTPUT"; fi
ic-wasm "$TASK_OUTPUT" -o "$TASK_OUTPUT" metadata candid:service -f crates/vault_canister/vault.did -v public --keep-name-section

if [[ "${ICP_ENVIRONMENT:-}" != "local-vault" ]]; then
  node scripts/check-vault-release.mjs "$TASK_OUTPUT"
fi
