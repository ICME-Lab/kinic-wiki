# Standalone Vault validation and split PRs

## Current implementation

The approved2026-11-16 follow-up enables pinned KINIC production funding and user-triggered authoritative ledger/archive reconciliation. Default backend Wasm builds without browser assets; only distribution builds enable embedded-assets. Fresh/current stores use schema8, older schemas reject unchanged. No production deployment, DNS change, existing-canister reinstall or live-funds transfer was performed.

## Reproduce

Use repository Rust toolchain, Node24, pnpm11.0.8, didc0.6.2, icp-cli1.0.2 and PocketIC16.1.0. Use frozen workspace and separate PocketIC dependencies. On hosts without npm, use the documented pinned npm11.6.2 via pnpm dlx.

```sh
pnpm install --frozen-lockfile
npm ci --prefix pocketic-tests --ignore-scripts
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
node --test scripts/vault-boundary-graph.test.mjs scripts/vault-build.test.mjs scripts/vault-release.test.mjs scripts/vault-ci-jobs.test.mjs
node scripts/check-vault-boundary.mjs
node packages/vault-client/scripts/generate-contracts.mjs --check
pnpm --filter './packages/vault-*' --filter vaultbrowser -r test
pnpm --dir packages/vault-client typecheck
pnpm --dir vaultbrowser typecheck
pnpm --dir pocketic-tests run build:vault-acceptance
POCKET_IC_BIN=/absolute/path/to/pocket-ic pnpm --dir pocketic-tests test:vault
POCKET_IC_BIN=/absolute/path/to/pocket-ic pnpm --dir pocketic-tests test:vault-funding-ledger
node pocketic-tests/scripts/run-vault-browser-acceptance.mjs
```

The dedicated backend PR also runs native tests, default asset-free Wasm and official-ledger reconciliation without Vault client/browser directories. The dedicated client PR runs frozen install, generated contracts, types and unit tests. The final integration replaces these interim workflows with fast checks, Wasm acceptance and real-II browser jobs, with source identity and SHA256 artifact handoff verification.

## Local evidence

Rust workspace:1234 passing test executions,4existing ignored; whole-workspace strict Clippy and fmt passed. Native Vault canister53, synthetic52; service test split retained all30original functions. Client/crypto51, Vault UI76, Wiki264and source checks, extension255, MCP111Node/330Vitest/120Workers passed. Graph/build/release/CI guards46passed. Types, contracts and strict production JS lint passed.

All six current Wasm cases passed using verified PocketIC16.1.0: lifecycle,state,capacity,isolation,physical-isolation,certification. These retain full-capacity admission, exact retry, schema8 upgrade and older-schema byte-preserving refusal, isolation and certified asset/configuration assertions. Production configuration now reports production funding and refuses foreign ledger configuration.

Official DFINITY ledger and archive release ledger-suite-icrc-2026-03-09 are pinned with SHA256 digests. On actual PocketIC16.1 they ran at the pinned production ledger principal in an isolated topology, using backend-only production policy. Tests passed actual ICRC2transfer/lost ingress replay once; post-await lost response reconstructed via actual archive calls and concurrent scans; wrong-spender transaction rejection;100block continuation and upgrade preservation. Native tests independently cover malformed blocks and accounting widths. The lost-response hook is inserted only into an archived, nondeployable source fixture; it is absent from production code. The first exploratory run used PocketIC12; it was explicitly superseded by a version-guarded16.1 rerun. Evidence/provenance:target/vault-funding-ledger-test-16.log and target/vault-funding-fault/provenance.json.

The real-II browser launcher passed all20existing checkpoints, including signed expiry and an actual299276ms idle interval, exact create/key/save lost-response payload retries, owner/context separation and private-reference cleanup. Its synthetic ledger isolates payment UI transport evidence from official-ledger evidence. It creates fresh owned network/identity material and checks teardown; a retained signer still succeeds until its delegation expires. Logout is not server-side credential revocation.

Desktop1280/mobile390 Funding fixtures separately verify zero implicit scans,10calls/click, resume toPaid, stopping after one request and no horizontal overflow. These use visibly labelled simulated responses, not payment evidence.

## UI quality limits

Vlmkit0.23 integrity is CLEAN at1280/768/375, scroll passes and interactions passes with3warnings. The unsuppressed handlers gate reports a React root delegated dragstart suspect, reproduced on the unchanged workspace baseline; the tool help documents this framework-delegation caveat. Funding implements no drag feature. The diagnostic drag probe additionally flags root/native text selection. This is individually assessed as a framework false positive, not an all-gates-clean claim. No fake draggable attributes, threshold changes or rule suppressions were introduced. Vite retains its large-chunk warning.

## Review and release

Two independent reviews identified and verified fixes for: known-unsent tip-preparation recovery, missing didc in isolated Wasm CI, compiler-override distribution risk and stale funding-disabled operational text. Full sharedUI and independent prerequisite CI, then backend/client and final integration CI must be evaluated on their published heads; local results alone do not authorize merge or deployment. Job durations and artifact sizes are recorded by CI for comparison with the previous15min53sec integrated Vault job.

See [PR dependencies](pr-split.md) and [operations](operations.md).
