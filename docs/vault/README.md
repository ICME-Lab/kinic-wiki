# Kinic Vault

Kinic Vault is an end-to-end encrypted document store built as a standalone Internet Computer canister and embedded browser application (`https://vault.kinic.xyz`). It is isolated from Kinic Wiki by canister, origin, Internet Identity derivation origin, SQLite storage, and deployment lifecycle.

## Core Security and Trust Model

- **Internet Identity ownership**: Users sign in with Internet Identity (`https://id.ai`) under the Vault canister's canonical derivation origin (`https://<vault-canister-id>.icp0.io`). There is no separate Vault password, recovery phrase, or out-of-band backup protocol. Losing Internet Identity access permanently loses Vault access unless Internet Identity itself is recovered.
- **Client-side encryption (`v3`)**: Each Vault derives a 32-byte symmetric root key via IC vetKD (`kinic-vault/ii-only/v1` → `kinic-vault/root/v3`), bound to the canister principal, immutable owner principal, Vault ID, immutable 32-byte nonce, and key name. Document metadata and content chunks are encrypted in the browser with AES-GCM (`kinic-vault/document/v3`) before upload.
- **Browser device-key cache**: Verified non-extractable AES-GCM root key handles are stored locally in IndexedDB, scoped to the canister and authenticated caller, to avoid repeated paid vetKD retrievals on the same browser. Reopening always re-authenticates and revalidates the Vault header and current access grant before reusing a handle.
- **Explicit trust boundaries**: Vault JavaScript, the Vault canister, Internet Identity, and their authorized controllers remain trusted. Local sign-out clears browser session state and SDK storage, but **does not revoke a retained session signing key and its still-valid II delegation** on the replica; expiry is enforced by the delegation's signed TTL (up to 8 hours) alongside a 30-minute client idle timeout.
- **Wiki isolation**: Wiki articles can reference private Vault documents only through opaque Markdown links (`[非公開資料](https://vault.kinic.xyz/embed/<vault-id>/<object-id>)`) selected via a cross-origin `/pick` popup and rendered inside a Vault-origin `/embed` iframe after independent Vault authentication.

## Architecture and Repository Layout

| Component | Path | Purpose |
| --- | --- | --- |
| Wire contract | [`crates/vault_canister/vault.did`](../../crates/vault_canister/vault.did) | Authoritative Candid API for owner, shared, funding, and controller methods |
| Canister | [`crates/vault_canister/`](../../crates/vault_canister/) | IC canister (`vault-canister`): vetKD derivation, certified HTTP/assets, ICRC-2 KINIC funding, reconciliation, Wiki credit bridge, schema 14 migrations |
| Domain service | [`crates/vault_service/`](../../crates/vault_service/) | Replayable mutation engine, operation/upload receipts, sharing authorization, and bounded cleanup |
| SQLite store | [`crates/vault_store/`](../../crates/vault_store/) | SQLite VFS persistence for Vault headers, encrypted revisions/chunks, grants, and capacity triggers |
| Shared Rust types | [`crates/vault_types/`](../../crates/vault_types/) | Candid-compatible Rust request, response, error, and capacity types |
| Generated Candid | [`packages/vault-candid/`](../../packages/vault-candid/) | Generated TypeScript/JavaScript Candid bindings (`@kinic/vault-candid`) |
| Browser crypto | [`packages/vault-crypto/`](../../packages/vault-crypto/) | vetKD context encoding, root derivation, and AES-GCM v3 document encryption (`@kinic/vault-crypto`) |
| Browser client | [`packages/vault-client/`](../../packages/vault-client/) | Authenticated actor wrapper, device-key cache, upload/retry orchestration, and session guards (`@kinic/vault-client`) |
| Web UI | [`vaultbrowser/`](../../vaultbrowser/) | Standalone React/Vite SPA embedded in the Vault canister's certified HTTP responses |
| Shared payments | [`packages/payments/`](../../packages/payments/) | Shared wallet/ICRC payment flow primitives used by funding UIs |
| Credit bridge types | [`packages/credit-bridge-candid/`](../../packages/credit-bridge-candid/) | Neutral Candid contracts for Wiki-to-Vault credit bridging |
| Integration tests | [`pocketic-tests/`](../../pocketic-tests/) | PocketIC Wasm lifecycle/upgrade/ledger suites and real-II Chromium acceptance runners |

## Documentation Map

| Guide | What it covers |
| --- | --- |
| [Protocol](protocol.md) | vetKD key derivation, AES-GCM v3 document format, mutation replay/upload reconciliation, deletion/GC, and Wiki `/pick` + `/embed` contracts |
| [Team access](team-access.md) | Owner/Editor/Viewer roles, member management workflow, shared wire methods, billing attribution, and revocation semantics |
| [Accounting and capacity](accounting-capacity.md) | Owner storage quotas, row bounds, prepaid accounts, upload reservations, cleanup credits, emergency key slots, storage fee math, and ledger reconciliation |
| [Operations and trust boundaries](operations.md) | Origin/II metadata setup, trust boundaries, browser session and device-key lifecycle, schema 14 upgrade/rollback rules, production KINIC funding, and release builds |
| [Validation and local testing](validation.md) | Reproducible unit, boundary, PocketIC Wasm, official-ledger, and real-II browser acceptance commands |
| [Vault Browser guide](../../vaultbrowser/README.md) | Web workspace UX, SPA routes, draft protection, device keys, and frontend fixture verification |
| [Wiki-to-Vault cycle refill](../operations/bekko-refill.md#vault-setup) | Controller runbook for configuring optional automated execution-cycle refills from Wiki to Vault |
