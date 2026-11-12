# Dedicated Kinic Vault

This browser and `crates/vault_canister` deploy independently of Wiki. Wiki only links to `https://vault.kinic.xyz`. No production canister, DNS, TLS or ledger changes have been made by this implementation.

## Build and verify

From the repository root:

```sh
pnpm --config.verifyDepsBeforeRun=false --config.managePackageManagerVersions=false --dir vaultbrowser build
bash scripts/build-vault-canister.sh
cargo test -p vault-canister -p vault-service -p vault-store --lib
pnpm --config.verifyDepsBeforeRun=false --config.managePackageManagerVersions=false --dir vaultbrowser test
node scripts/check-vault-boundary.mjs
node packages/vault-client/scripts/generate-contracts.mjs --check
```

The Vault Wasm embeds only this browser's `dist` files and serves certified SPA, `/config.json`, `/.well-known/ii-alternative-origins` and `/.well-known/ic-domains` responses. Missing browser artifacts fail Wasm builds. There is no mutable asset-upload endpoint or third-party hosted JavaScript dependency. Each asset must fit the IC single-response limit; the current largest bundle is about 1.02 MB before compression.

The independent `vaultbrowser/icp.yaml` names only `vault`; the root Wiki manifest names only `wiki`. Use an explicit environment and canister when a deployment is separately authorized. `local-vault` uses port 8024, distinct from Wiki's 8011. Mainnet build metadata allows only `vault.kinic.xyz`, with derivation origin `https://<this-vault-canister-id>.icp0.io` and `https://id.ai` as the II provider. There is no Wiki alternative origin.

For a local build, pass `ICP_ENVIRONMENT=local-vault`, `VAULT_LOCAL_ORIGIN`, `VAULT_LOCAL_HOST` and `VAULT_LOCAL_II` explicitly. The origin must be a separate `*.localhost` origin, the host must be a localhost/127.0.0.1 replica with an explicit port, and the provider must be the local II URL. The browser validates these fields and never fetches a replacement root key for mainnet. Serve the compiled browser through its canister gateway; the Vite fixture is a separate synthetic test entry.

## Configuration and prepaid funding

Both operation configuration and funding are disabled after a fresh install. Controllers configure the exact RP/origin/key name/minimum canister balance with `set_config`, and explicitly set the trusted KINIC ledger, recipient and `cycles_per_kinic` with `set_funding_config`. Use the dedicated Vault canister's own account as recipient unless an explicit trusted treasury is intended. There is no implicit Wiki collector, free grant or payer database selector.

`quote_purchase` accepts a 16-byte operation ID, beneficiary Vault principal, KINIC e8s amount, minimum credits and nanosecond creation time. Before querying the fee, it validates the request and reserves a durable slot counted against the payment record limits. Fee lookups are limited to eight globally and one per wallet, with 120-second leases, 60-second call waits and upgrade/token fencing. Failed fee calls release their own slot. It queries the configured ledger's fee and persists the exact wallet caller, recipient, ledger, rate, fee, amount, credits, memo and timestamp. The quote lasts five minutes; minimum purchase is 20 million credits. The payer must approve the dedicated canister as spender for amount plus transfer fee (approval has its own ledger fee).

`pay_purchase` is callable only by that same wallet and always transfers from that authenticated wallet. Any authenticated wallet may fund an explicit beneficiary; the wallet principal may differ from the Vault II principal. Data access and account spending still belong solely to the beneficiary's Vault principal. The UI currently provides funding from the Vault identity's own KINIC account; an external-wallet picker is outside Task 4.

Success or `Duplicate` for the pinned request credits once in the same SQLite transaction as its receipt. Calls wait at most 60 seconds. `Unknown`, upgrade-orphaned and timed-out requests retain their original transfer arguments; bounded retries never create another transaction. An old callback cannot settle a newer attempt. Uncertain payments remain uncertain even if a subsequent retry reports BadFee, insufficient balance/allowance or TooOld. After 23 hours or 100 attempts, automatic retry is refused and authoritative ledger reconciliation is required. No controller endpoint fabricates a successful payment or clears uncertainty; unresolved payments remain pinned until a separately reviewed ledger reconciliation procedure establishes the outcome.

`list_payments` and `payment_status` recover the wallet's operations after reload. Only a still-unpaid quote can be cancelled. Known BadFee/allowance/balance failures allow an explicitly requested new quote. Never create a replacement to recover an unknown payment. Payment storage is bounded to 1,024 records globally and 16 per wallet; unpaid quotes expire after five minutes, resolved receipts after seven days, and uncertain records are retained within the global limit. The private account journal keeps its latest 10,000 entries. Balance reads allocate no zero account.

## Scope and remaining acceptance

The independent DB owns storage billing, measured execution checkpoints, reservation/refund journals, expiry maintenance and generation recovery. It retains the existing Vault quotas and vetKD limits. SQLite's one-GiB page cap applies only to the dedicated Vault, independently of Wiki.

The standalone core UI uses the current generation-bound signed mutation API: bootstrap registration, Normal grants for encrypted CRUD, and Credentials grants for ordinary passkey management. Ordinary removal preserves the VRK and recovery material. Restore, incident response and scoped-passkey creation use their dedicated reviewed clients and views; the removed legacy restore flow is not offered.

Shared logical capacity is 200 MiB including the 16 MiB accounting floor, ciphertext/history/pending data and control records; each namespace reserves 512 KiB within the same limits for completion/cleanup. Funding does not increase capacity. With insufficient balance, encrypted export and authenticated bounded cleanup remain available. Full active-Vault purge uses an exact passkey cleanup grant. Pending creation uses exact namespace/vault/attempt cancellation; only an unregistered bootstrap uses the server's existing narrow owner-only cancellation exception.

Vault encryption keys, mutation signers, document/search state and recovery material are browser-session-only. Internet Identity's origin-local delegation/base identity uses the AuthClient's own browser storage; that credential is distinct from Vault content and encryption keys. Lock destroys references, clears sensitive mounted/detached DOM and CodeMirror state/undo, cancels WebAuthn, revokes downloads, and fences late asynchronous results. It does not promise physical RAM erasure or clear an explicitly copied clipboard or a user-saved recovery kit. Vault's optional autocomplete is disabled to avoid queued completion sources retaining private editor state; default Wiki editor behavior is unchanged.

Encrypted v1 archives remain readable; live v2 exports pin root-envelope revision zero separately from generation epoch. Recovery-kit files are explicitly downloaded and selected inside the private session. The supplied offline helper, `tools/vault-recovery/src/main.mjs`, opens v1/v2 archives without networking. Test-only `fixtures` and `verify-fixture.mjs` use synthetic actors and data and are not production entry points.

Build the fake ledger with `node pocketic-tests/scripts/build-vault-ledger.mjs`, then run `pocketic-tests/integration/vault-isolation.test.mjs` with the local `POCKET_IC_BIN` when backend acceptance is in scope. Task 15 verifies real browser editing/locking and client crypto/signatures with mocked remote boundaries; it does not establish real KINIC transfers, two real II accounts, real passkey hardware, certified two-origin acceptance, or final browser-to-canister acceptance.

## Incident response, restoration and scoped creation

`Recovery and access` offers three explicit actions. Ordinary passkey removal remains separate and does not change encryption roots.

- Incident response requires a trusted remaining passkey covering every instance affected by the selected compromised credentials. Admission revokes those credentials and freezes the entire affected set. For each target, save and reselect the new kit, resume record preparation, then save and fully verify its new backup. Only every target's current acknowledgment enables fresh whole-incident proof and atomic commit. Cancellation/reset leaves old writes frozen and never claims completed protection.
- All-passkeys-lost restoration starts from a selected saved source archive and either its v2 kit or the original v1 raw base64url recovery secret. Older-source/live collisions require the current live kit separately. The new scoped passkey may be an existing scoped key, including when all ten physical slots are occupied. Each target still requires its own current proof. Full local source validation and server capacity preflight precede the explicit destructive discard. Discard removes current live content/history before import; cancellation cannot restore it, so keep the original saved source files.
- Save and reselect the restoration's new kit and encrypted prepared target archive before import. After interruption, reselect the source, original secret/kit, saved prepared target and new kit; preparation resumes without recreating randomized wrappers. The same prepared archive is reselected for full comparison with restored server content before activation. If preparation never saved both target files, cancel that exact attempt and start a new one. A separately restored frozen Vault does not complete its parent incident or authorize another frozen Vault.
- A scoped key can deliberately create a separate **new empty** Vault using proof of a current source instance. Save/reselect the new kit before activation. Exact never-active cancellation remains available to the owner even if the creator/source is gone; it does not delete an active or other existing Vault.

All workflow clients share the core private session. File selections, raw buffers, helper/actor continuations, password input and signers are bound to its generation; lock, route exit and identity changes fence old work. Encrypted resume archives are explicitly user-saved files, not persistent browser state. File verification and user acknowledgment cannot attest disk durability. Use a trusted replacement and revoke lost devices at the passkey sync provider; rotate exposed passwords/API keys at their external services. Old backups still open with their old kits.

`fixtures/recovery.html` and `verify-recovery-fixture.mjs` exercise synthetic local actors, with actual React, signing, cryptography, downloads and file reselection. They do not establish real II/passkey hardware, current-Wasm execution, certified responses or browser-to-canister acceptance. The browser's required markup inventory still reports React's root drag registration; no fake draggable or suppression is applied. Current production bundle size is about 1.02 MB before compression, with Vite's existing large-chunk/dynamic-import advisories visible.

## Shared implementation and release state

Editor, Markdown, native primitives, CSS and Tailwind theme are shared with Wiki through `@kinic/ui`. Private rendering policy, authentication/principal, session keys, plaintext and accounting remain Vault-owned. Current canister upgrades support complete schema6 only; pre-release canister migration paths are retired. Existing v1/v2 backups and the independent offline tool remain supported. Use the unified fixture builder and acceptance commands in `docs/vault/validation.md`; the pinned backend comparison is3dc9c7c5 rather than development Task snapshots.
