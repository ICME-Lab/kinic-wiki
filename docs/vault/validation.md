# Vault Validation and Local Testing

See [Vault overview](README.md) for component layout and [operations](operations.md) for release build requirements.

## Prerequisites

Use the repository Rust toolchain (`rust-toolchain.toml`), Node 24, `pnpm` 11.0.8, `didc` 0.6.2, `icp-cli` 1.0.2, and PocketIC 16.1.0. Keep workspace dependencies frozen (`--frozen-lockfile` / `--locked`) and install `pocketic-tests` dependencies separately. On hosts without `npm`, use pinned `npm` 11.6.2 via `pnpm dlx`.

## Fast Checks (Unit, Lint, Contracts, Boundaries)

From the repository root:

```sh
pnpm install --frozen-lockfile
npm ci --prefix pocketic-tests --ignore-scripts

# Rust workspace tests, Clippy, and formatting
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check

# Boundary, build, release, and CI guards
node --test scripts/vault-boundary-graph.test.mjs scripts/vault-build.test.mjs scripts/vault-release.test.mjs scripts/vault-ci-jobs.test.mjs scripts/vault-browser-teardown.test.mjs vaultbrowser/scripts/shared-payment-preflight.test.mjs
node scripts/check-vault-boundary.mjs

# Candid contract check, TypeScript tests, and typechecks
node packages/vault-client/scripts/generate-contracts.mjs --check
pnpm --dir packages/credit-bridge-candid test
pnpm --filter './packages/vault-*' --filter @kinic/payments --filter vaultbrowser -r test
pnpm --dir packages/vault-client typecheck
pnpm --dir packages/payments typecheck
pnpm --dir vaultbrowser typecheck
```

Native Rust tests include contract migrations validating all supported predecessor layouts (owner schemas 8/9/10, grant-bearing 10, team 11, subsidy 11/12, and combined 13) up to schema 14, rejecting unknown or hybrid layouts atomically.

## PocketIC Wasm and Official-Ledger Acceptance

Build the acceptance Wasm artifacts and run the PocketIC suites with a verified PocketIC 16.1.0 binary:

```sh
pnpm --dir pocketic-tests run build:vault-acceptance
POCKET_IC_BIN=/absolute/path/to/pocket-ic pnpm --dir pocketic-tests test:vault
POCKET_IC_BIN=/absolute/path/to/pocket-ic pnpm --dir pocketic-tests test:vault-funding-ledger
```

- `test:vault` exercises real Vault Wasm, vetKD, initial grant/subsidy, full-capacity admission, exact retries, same-format upgrades, team sharing, isolation, and certified asset/configuration assertions (`initial-grant`, `lifecycle`, `sharing`, `state`, `capacity`, `isolation`, `physical-isolation`, `certification`).
- `test:vault-funding-ledger` downloads the SHA-256-pinned official DFINITY ledger/archive release (`ledger-suite-icrc-2026-03-09`) and runs against the production ledger principal in an isolated topology to test ICRC-2 transfer replay, archive reconciliation, concurrent scans, wrong-spender rejection, 100-block continuation, and upgrade preservation. The lost-response hook is injected only into a disposable test build and is absent from production code.

To run only the team-sharing and certification Wasm scenarios after building artifacts:

```sh
POCKET_IC_BIN=/absolute/path/to/pocket-ic node pocketic-tests/scripts/run-vault-acceptance.mjs sharing state certification
```

## Real-II Browser and Wiki Embed Acceptance

These runners use `icp-cli` 1.0.2 with isolated local networks, hash-checked Internet Identity Wasm with virtual WebAuthn passkeys, certified Vault assets, and a synthetic ledger (isolating browser/II/UI transport verification from the official-ledger suite above):

```sh
# Full Vault browser acceptance (II login, expiry/idle, retries, context isolation)
node pocketic-tests/scripts/run-vault-browser-acceptance.mjs

# Team sharing + Wiki editor picker and Vault-origin iframe embed acceptance
node pocketic-tests/scripts/run-vault-browser-acceptance.mjs --team-embeds

# Shared wallet payment UI acceptance (II, local ICRC signer, Plug fixture)
node pocketic-tests/scripts/run-vault-browser-acceptance.mjs --payments-only

# Wiki private-reference Playwright component fixture
pnpm --dir wikibrowser exec playwright test -c fixtures/vault-reference/playwright.config.ts
```

Note on scope:

- Synthetic browser fixtures (`vaultbrowser/fixtures/`) and unit tests substitute vetKD/ledger backends with in-memory or synthetic data and do not replace PocketIC Wasm or real-II acceptance.
- Local verification runners never deploy to mainnet, change DNS, or transfer live funds.
- Browser acceptance verifies that local logout clears client storage while a retained session signing key remains valid on the replica until its signed delegation expires.

## Local Cross-Origin Development (Wiki + Vault)

To test the Wiki `/pick` popup and `/embed` iframe locally, pair Vault's build-time `VAULT_LOCAL_WIKI_ORIGIN` with Wiki's `VITE_LOCAL_VAULT_ORIGIN`:

- Vault build: `ICP_ENVIRONMENT=local-vault`, `VAULT_LOCAL_WIKI_ORIGIN=http://127.0.0.1:3016` (plus `VAULT_LOCAL_ORIGIN`, `VAULT_LOCAL_HOST`, `VAULT_LOCAL_II`)
- Wiki fixture: `VITE_LOCAL_VAULT_ORIGIN=http://<vault-canister-id>.localhost:<gateway-port>`

Use the actual canister ID and gateway port. Both origins must be distinct canonical loopback origins. A local Vault build without `VAULT_LOCAL_WIKI_ORIGIN` denies framing and picker connections. In production, the Wiki and Vault origins are fixed (`https://wiki.kinic.xyz` and `https://vault.kinic.xyz`).
