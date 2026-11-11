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

The Vault Wasm embeds only this browser's `dist` files and serves certified SPA, `/config.json`, `/.well-known/ii-alternative-origins` and `/.well-known/ic-domains` responses. Missing browser artifacts fail Wasm builds. There is no mutable asset-upload endpoint or third-party hosted JavaScript dependency. Each asset must fit the IC single-response limit; the current largest bundle is about 932 KB before compression.

The independent `vaultbrowser/icp.yaml` names only `vault`; the root Wiki manifest names only `wiki`. Use an explicit environment and canister when a deployment is separately authorized. `local-vault` uses port 8024, distinct from Wiki's 8011. Mainnet build metadata allows only `vault.kinic.xyz`, with derivation origin `https://<this-vault-canister-id>.icp0.io` and `https://id.ai` as the II provider. There is no Wiki alternative origin.

For a local build, pass `ICP_ENVIRONMENT=local-vault`, `VAULT_LOCAL_ORIGIN`, `VAULT_LOCAL_HOST` and `VAULT_LOCAL_II` explicitly. The origin must be a separate `*.localhost` origin, the host must be a localhost/127.0.0.1 replica with an explicit port, and the provider must be the local II URL. The browser validates these fields and never fetches a replacement root key for mainnet. Serve the compiled browser through its canister gateway; the Vite fixture is a separate synthetic test entry.

## Configuration and prepaid funding

Both operation configuration and funding are disabled after a fresh install. Controllers configure the exact RP/origin/key name/minimum canister balance with `set_config`, and explicitly set the trusted KINIC ledger, recipient and `cycles_per_kinic` with `set_funding_config`. Use the dedicated Vault canister's own account as recipient unless an explicit trusted treasury is intended. There is no implicit Wiki collector, free grant or payer database selector.

`quote_purchase` accepts a 16-byte operation ID, beneficiary Vault principal, KINIC e8s amount, minimum credits and nanosecond creation time. It queries the configured ledger's fee and persists the exact wallet caller, recipient, ledger, rate, fee, amount, credits, memo and timestamp. The quote lasts five minutes; minimum purchase is 20 million credits. The payer must approve the dedicated canister as spender for amount plus transfer fee (approval has its own ledger fee).

`pay_purchase` is callable only by that same wallet and always transfers from that authenticated wallet. Any authenticated wallet may fund an explicit beneficiary; the wallet principal may differ from the Vault II principal. Data access and account spending still belong solely to the beneficiary's Vault principal. The UI currently provides funding from the Vault identity's own KINIC account; an external-wallet picker is outside Task 4.

Success or `Duplicate` for the pinned request credits once in the same SQLite transaction as its receipt. Calls wait at most 60 seconds. `Unknown`, upgrade-orphaned and timed-out requests retain their original transfer arguments; bounded retries never create another transaction. An old callback cannot settle a newer attempt. Uncertain payments remain uncertain even if a subsequent retry reports BadFee, insufficient balance/allowance or TooOld. After 23 hours or 100 attempts, automatic retry is refused and authoritative ledger reconciliation is required. No controller endpoint fabricates a successful payment or clears uncertainty; unresolved payments remain pinned until a separately reviewed ledger reconciliation procedure establishes the outcome.

`list_payments` and `payment_status` recover the wallet's operations after reload. Only a still-unpaid quote can be cancelled. Known BadFee/allowance/balance failures allow an explicitly requested new quote. Never create a replacement to recover an unknown payment. Payment storage is bounded to 1,024 records globally and 16 per wallet; unpaid quotes expire after five minutes, resolved receipts after seven days, and uncertain records are retained within the global limit. The private account journal keeps its latest 10,000 entries. Balance reads allocate no zero account.

## Scope and remaining acceptance

The independent DB owns storage billing, measured execution checkpoints, reservation/refund journals, expiry maintenance and generation recovery. It retains the existing Vault quotas and vetKD limits. SQLite's one-GiB page cap applies only to the dedicated Vault, independently of Wiki.

Task 4 preserves the existing crypto protocol. Fresh restore nonces, generation-bound authorization, ordinary removal versus incident rotation, and fresh recovery-kit/backup cutover are Task 5–7 work; this checkpoint is not a production release. Native synthetic payment tests and a PocketIC test using a separate fake ICRC-2 ledger are included. Build the fake ledger with `node pocketic-tests/scripts/build-vault-ledger.mjs`, then run `pocketic-tests/integration/vault-isolation.test.mjs` with the local `POCKET_IC_BIN`. Real KINIC transfers, two real II accounts, real passkey acceptance and final browser-to-canister acceptance have not been executed here.
