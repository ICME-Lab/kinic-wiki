# Standalone II-only Vault validation

This release uses a dedicated Vault canister, certified application assets, an origin-derived Internet Identity principal and browser encryption. Validation distinguishes real Wasm execution, real II browser sessions and synthetic UI fixtures. No production deployment, live-ledger payment, existing-canister reinstall or independent external audit is claimed.

## Reproduce

Use the repository Rust toolchain, Node 24, pnpm 11.0.8, didc 0.6.2, icp-cli 1.0.2 and PocketIC 16.1.0. Workspace dependencies and the separate PocketIC dependencies are locked.

```sh
pnpm install --frozen-lockfile
npm ci --prefix pocketic-tests --ignore-scripts
pnpm audit --audit-level moderate
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo machete
node scripts/check-vault-boundary.mjs
node packages/vault-client/scripts/generate-contracts.mjs --check
pnpm --filter './packages/vault-*' --filter vaultbrowser -r test
pnpm --dir packages/vault-client typecheck
pnpm --dir vaultbrowser typecheck
pnpm --dir pocketic-tests run build:vault-acceptance
POCKET_IC_BIN=/absolute/path/to/pocket-ic-16.1.0 pnpm --dir pocketic-tests test:vault
pnpm --dir wikibrowser exec playwright install chromium
node pocketic-tests/scripts/run-vault-browser-acceptance.mjs
```

The CI job also runs strict production/fixture lint and uses Ubuntu 24.04 plus pinned tool downloads. It builds the same current production assets and schema 8 fixtures before running the six cases and real-II browser launcher. Deleted backup/recovery packages and historical artifact paths are no longer part of CI. Shared UI changes continue to select both Wiki and Vault checks; Rust/learning-example/CLI filters are retained. Hosted CI must still run on the final published commit.

For local machines without an npm executable, the tested separate dependency command is `pnpm --package=npm@11.6.2 dlx npm ci --prefix pocketic-tests --ignore-scripts`. `VAULT_BUILD_CACHE` and `VAULT_BROWSER_BUILD_CACHE` can point to an external native cache without changing the recorded output artifacts. No build-cache override authorizes reuse of an existing network or canister.

## Evidence and artifacts

The 2026-11-13 state-simplification acceptance rebuilt the clean source commit `991465746d9e6080b32d9afb2750c7791078e0b4` (backend `7bd15087`, client/UI `99146574`). It produced production Vault Wasm SHA-256 `7921dc07097c32b832edd3b4407b4e9c56c7dc0f37cf02dd1335ed5305084264`. This supersedes the earlier `8351e66d` runtime evidence; subsequent validation prose and CI display-label edits do not change tested product or harness source. All six current cases passed: lifecycle, state, capacity, isolation, physical-isolation and certification, including teardown. The production artifact has funding compiled unavailable. Test state/accounting injection and synthetic funding are separately built nondeployable artifacts.

| Artifact                                                                | Provenance/purpose                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| `target/vault-ii-acceptance/vault_canister.wasm`                        | Current production assets and default funding-disabled backend |
| `target/vault-ii-acceptance/vfs_canister.wasm`                          | Independent current Wiki canister                              |
| `target/vault-ii-acceptance/vault-state.wasm`                           | Current-source, controller-only test SQL fixture               |
| `target/vault-ii-acceptance/vault-old-schema.wasm`                      | Minimal old-schema refusal fixture                             |
| `target/vault-synthetic-funding-build/…/vault_canister.wasm`            | Nondeployable synthetic-funding variant                        |
| `target/wasm32-unknown-unknown/release/vault_ledger_fixture.wasm`       | Nondeployable synthetic ledger                                 |
| `target/vault-ii-acceptance/client/client.mjs`                          | Actual current client/crypto bundle                            |
| `target/vault-ii-acceptance/{production,state,old-schema,runtime}.json` | Exact source, artifact, runtime and harness hashes/results     |
| `target/vault-browser-readback/readback.mjs`                            | Test-only inspector, excluded from production assets           |
| `target/vault-browser-provenance.json`                                  | Actual browser network/II/Wasm provenance                      |
| `target/vault-browser-teardown.json`                                    | Owned ports/process teardown and fixture identity removal      |
| `target/vault-ii-acceptance/browser/results.json`                       | Completed real-II browser case results                         |

The six-case suite does not use a real II delegation: PocketIC supplies the caller to the actual client and canister. It verifies real anchored vetKD, encrypted document v3, owner/canister/Vault/nonce isolation, exact retries, full-capacity prepaid upload completion, fresh key/read access through bounded protected admission, zero-credit cleanup, fair durable GC, schema 8 preservation and unchanged rejection of schemas 1–7. Default-production upgrade tests retain synthetic prepaid credit and prove existing/new encrypted content still works with funding unavailable. Certification checks verify the real IC certificate/tree/body/status/security headers and reject tampering.

The state case fills shared capacity with another owner's retained live-revision accounting charge and fills 10,000 ordinary receipt rows, then uses a fresh client without a root/transport attempt to derive and decrypt the saved plaintext. It checks a first-ever derive by a distinct funded owner, exact lost-key replay without new allocations, changed-body conflict and protected-receipt preservation through schema 8 upgrade. Injected logical accounting reaches the boundary without allocating 200 MiB of ciphertext. Native tests separately fill the owner ordinary-row cap, exhaust the 64-global/16-owner emergency pool without exceeding capacity, retain normal 100/day admission, reuse the eight transient flight slots across nine settled owners, and fence invalid/unfunded/foreign/concurrent/late requests.

The physical-isolation case uploads and decrypts a real 2 MiB random attachment, measures logical/physical growth, then independently creates/writes/upgrades/deletes Wiki state and rederives the unchanged Vault root. Its sample is empirical, not a full-capacity or worst-case physical memory bound.

## Actual II browser method

The launcher creates a unique project under `target/vault-browser-network-*`, a project-owned `ICP_HOME` and disposable controller identity. It allocates a free random gateway port and probes existing certified Wiki dev origins on ports 3100/3010 before claiming one. It never kills an occupied unrelated listener. Each run installs fresh Wiki, Vault, synthetic-ledger, II backend and II frontend canisters. II release `release-2026-05-08` is pinned by compressed SHA-256 for both artifacts; cached downloads are reverified before use. Dummy authentication is disabled. Bundled Playwright Chromium uses a virtual WebAuthn authenticator only in the real II popup, with zero Vault-origin credential API calls.

After the synthetic funding step, the same fresh owned Vault is upgraded to a default-feature, local-origin binary. Its certified configuration reports funding unavailable, Get quote is disabled, and retained credit supports the remaining real-II operations. Both local binary hashes are recorded. A default-feature local-origin artifact is still not a deployable mainnet artifact. The exact mainnet-configured production Wasm is covered separately by the six-case suite.

The certified Vault application entry and configuration are used throughout. The readback module is served only by owned test interception, uses the actual SDK delegation and real actors, and imports the unchanged production client/crypto. Lost-reply tests forward actual ingress and discard only its HTTP response. Each create, key-acquisition and single-chunk save case records complete Candid argument hashes before routing, labels dropped requests and successful requests after the explicit Retry/Resume click, and requires a nonempty successful application retry matching the original dropped payload. This covers create operation IDs, derive operation IDs/transport keys and mutation operation IDs/ciphertext. Collectors close before independent client derivations or later uploads. Delayed-reply tests hold the real response. No mock provider, root verification, actor result, document cipher or independent Vault factor is used. Synthetic ledger transfers are actual inter-canister calls, with no real token economics or live funds.

The expiry probe requests a shorter real II delegation through a test-only AuthClient login, then reloads the production entry using the normal SDK storage. It inspects the signed expiration, keeps editing until that time, checks immediate private-view removal and sends a captured old actor's update to verify the replica's expired-delegation rejection. Browser/replica clocks and the application's eight-hour TTL/five-minute idle constants remain unchanged. A separate test obtains a fresh normal-login delegation, records its signed expiry before and after the actual five-minute idle interval, and confirms that the retained signer still succeeds after local logout while its delegation remains valid. Ordinary SDK logout only clears this browser's SDK key/delegation storage: a retained session signing key plus its still-valid delegation remains usable until signed expiry.

The 2026-11-13 current-source run passed all 20 checkpoints on Chromium 149.0.7827.55. Each of the create, derive and PutChunk collectors recorded four dropped HTTP 200 responses and one successful post-click request with the same full Candid argument SHA-256. Natural idle logout occurred after 299,271 ms with 28,496,692 ms still remaining on the same signed delegation; the retained signer succeeded after local logout. The separate 35-second expired signer received replica HTTP 400 on all three attempted ingress calls. Owned teardown passed, including both port-rebind checks and fixture identity removal.

The driver covers login/create/write/read/relogin, a second browser context with fresh application storage, another II/anonymous denials, same-page owner and Vault switching, Wiki principal/derivation-origin separation, same-origin DOM and frame CSP, exact create/key/save retries, save cancellation, real history downloads, and late read/key callbacks after close/logout. Persistence checks distinguish documented SDK authentication records and public subnet-key caches from forbidden Vault roots/DEKs/plaintext. Private DOM/editor undo/password/File references and owned Blob URLs are cleared; physical memory erasure is not claimed. Explicit downloads and clipboard copies remain outside that guarantee.

The launcher stops only its owned server process group and project network, removes the disposable identity/seed, and checks that both owned ports can be bound again. CI publishes provenance/results JSON only, excluding test identity material, browser storage and downloaded plaintext.

## Current local checks and remaining limits

The backend verification for `7bd15087` passed 1,218 aggregate Rust result-summary tests with 4 existing ignored cases. Strict Clippy (default and synthetic-funding variants), formatting and cargo-machete passed. The only later Rust edits before that commit simplified three test closures; the affected 30 service tests and strict Clippy passed afterward. Current client/crypto tests at `99146574` passed 48 and Vault UI tests passed 66; both type checks, strict lint, generated contracts and origin boundary checks passed. This integrated acceptance reused those exact source checks and rebuilt all assets/Wasm before its six-case and real-II runs. No product or harness edits were needed during integrated acceptance.

New regression coverage includes a single ordinary deletion journal receipt, typed upload outcomes, key-target callback fencing, all save-phase response losses, exact cancel/delete progress replay, concurrent starts and old-finally/new-work races. Existing checks retain closed Collect retry, zero-credit purge, detached DOM/editor undo/password/File clearing and owner/Vault isolation. The unchanged Wiki sources had previously passed 264 tests/source checks; Wiki/CLI suites were not rerun locally for this Vault-only refactor. Prior frozen-install and moderate-audit results used host pnpm 11.25.0 and exact CI pin 11.0.8 with the unchanged inherited braces exception; dependencies/lockfiles were not changed or re-audited in this follow-up. Hosted CI on the final published head remains a separate required result.

The owned synthetic Chromium fixture now requires a completed history download, matching filename/content and a nonempty matching Blob create/revoke pair. It also checks keyboard exit/preview, refresh retention, private undo/password/File clearing and mobile navigation/focus. Its key acquisition is substituted and is not real-II evidence.

For this refactor, Vlmkit 0.23.0 interactions on the owned synthetic fixture passed with 9 interactive elements and two existing `inert-control` warnings (Close Vault in a closed view, and Refresh Vaults with unchanged data). That fixture substitutes key acquisition and is not real-II evidence. Historical integrity/copy/scroll results had no findings; the historical unsuppressed handler gate still had two React/CodeMirror `drag-source-not-draggable` suspects and one handler-inventory warning. Those gates were not rerun for this follow-up, and **no all-gates-CLEAN result is claimed**. No fake attributes, threshold changes or suppressions were added. The current Vite build retains its >500kB minified-chunk warning.

Production funding and authoritative ledger reconciliation remain blocked; these tests do not establish live payment recovery. The local browser assumes trusted fixture root keys; production retains its IC trust anchor. [Operations](operations.md) describes the II/updater trust, retained signing-identity boundary, schema and capacity limits.
