# Kinic Vault Browser (`vaultbrowser`)

Embedded React/Vite frontend for the standalone Kinic Vault canister. Vault deploys independently of Kinic Wiki (`vaultbrowser/icp.yaml`); Wiki links to `https://vault.kinic.xyz` and the browser constructs its own authenticated actor for the dedicated Vault canister.

For system-level architecture, encryption protocol, trust boundaries, team access, and capacity rules, see:

- [Vault overview](../docs/vault/README.md)
- [Protocol](../docs/vault/protocol.md)
- [Team access](../docs/vault/team-access.md)
- [Operations and trust boundaries](../docs/vault/operations.md)
- [Accounting and capacity](../docs/vault/accounting-capacity.md)
- [Validation and local testing](../docs/vault/validation.md)

## Wiki Integration Links

Set Wiki's `VITE_PRIVATE_VAULT_URL` to the published Vault URL to show **Private Vault** below **Dashboard** in desktop and mobile navigation (leave empty when disabled). For local testing, set it to the local Vault gateway URL and build Vault with `VITE_WIKI_URL=http://127.0.0.1:3100/dashboard` so **Back to Wiki** returns to the local Wiki. Vault defaults to the production Wiki dashboard when `VITE_WIKI_URL` is unset.

## Workspace Features and UX Rules

- **II-only access**: Sign in with Internet Identity, select or create a Vault, and work with `v3` client-encrypted documents (notes with private Markdown preview, saved credentials, and attachments). There is no additional Vault passkey, unlock credential, backup, or independent recovery.
- **On-demand decryption**: Document lists decrypt metadata only; opening a document fetches and decrypts its contents.
- **Version history**: **Show version history** lists saved revisions. **View revision** displays a revision read-only; **Return to latest version** resumes the current document. **Download document** downloads the displayed saved revision. Historical views cannot overwrite the latest version.
- **Document actions**: Each document card has an **…** menu for renaming, **Delete document** (history retained), and **Permanently delete document and history** (irreversible). Both deletions open a confirmation dialog naming the target and require typing `delete`. Permanent deletion remains available with zero prepaid balance.
- **Vault renaming**: Each Vault card has an **… → Rename Vault** action (owner-only plaintext display metadata up to 64 characters; survives upgrades and does not change the root key or require a key retrieval). Existing Vaults keep the `Vault 1` fallback until renamed. Deploy a backend accepting `RenameVault` before publishing UI that calls it; mutation receipt hashes preserve backward compatibility with historical Candid shapes (`crates/vault_service/src/tests/fixtures/README.md`).
- **In-session recovery**: Pending creation and interrupted saves stay in memory for retry/resume/cancel within the session. **Settings** provides storage maintenance (**Free up unused storage**), browser key removal (**Delete saved keys from this browser**), and permanent Vault deletion (requires typing the Vault name).
- **Session & device keys**: Uses AuthClient 5.0.0 with an 8-hour delegation TTL and 30-minute idle timeout across workspace, `/pick`, and `/embed`. Verified non-extractable AES-GCM root keys are cached in IndexedDB scoped to caller and canister and revalidated on reopen. See [operations](../docs/vault/operations.md#browser-session-and-device-keys) for exact cross-tab, teardown, and revocation boundaries.

### SPA Navigation and Draft Protection

The embedded React/Vite app uses TanStack Router for `/`, `/settings`, and `/help` (no SSR; routes contain no private document or Vault identifiers). The private client and editor stay mounted while visiting Settings or Help.

Unsaved edits require confirmation before manually switching documents/Vaults, closing Vault, signing out, or removing browser keys; reload/close uses the browser's native leave prompt. Automatic lock and expiry cancel pending confirmations and wipe immediately. The startup shell provides loading, `<noscript>`, and generic reload/retry recovery. Password copying reports success or failure only for the active credential.

### Credit, First-Key Sponsorship, and Funding

- **Initial grant and first-key subsidy**: New Vault principals receive 10B operating cycles once plus one service-sponsored management key retrieval fee through an explicit authenticated account-initialization update (balance queries never allocate or grant). Migration from pre-benefit schemas excludes existing accounts from new benefits while preserving existing balances and history.
- **Key-fee preflight**: Creation includes the owner share of the current default key retrieval price (`owner_fee`, zero while the first-key subsidy is available) plus minimum execution credit. Existing Vaults price against their own header key name. When a missing key cannot be funded, the selected Vault shows inline funding and retries opening that same Vault once credited.
- **Subsidy lifecycle**: The protected receipt transitions `available → reserved → used` keyed by the server-issued operation token. Zero-cost failures restore eligibility; charged failures consume it. The receipt survives Vault deletion, device-key removal, and journal GC.
- **Funding & schema 14**: Production KINIC funding supports user-requested ledger reconciliation against the pinned KINIC ledger (`73mez-iiaaa-aaaaq-aaasq-cai`). Deploy the schema 14 backend before serving UI that calls shared, rename, initialization, or key-price endpoints. See [operations](../docs/vault/operations.md#schema-14-and-upgrades) and [accounting and capacity](../docs/vault/accounting-capacity.md).

## Build and Verify

From the repository root:

```sh
pnpm --dir vaultbrowser test
pnpm --dir vaultbrowser typecheck
pnpm --dir vaultbrowser build
pnpm --filter @kinic/vault-client test
node packages/vault-client/scripts/generate-contracts.mjs --check
node scripts/check-vault-boundary.mjs
wikibrowser/node_modules/.bin/oxlint --deny-warnings vaultbrowser/src vaultbrowser/fixtures/main.tsx vaultbrowser/fixtures/network.ts packages/vault-client/src packages/vault-client/test
```

The production browser bundle is embedded into the Vault canister via `bash scripts/build-vault-canister.sh`. Local certified builds require `ICP_ENVIRONMENT=local-vault`, `VAULT_LOCAL_ORIGIN`, `VAULT_LOCAL_HOST`, and `VAULT_LOCAL_II` (plus `VAULT_LOCAL_WIKI_ORIGIN` for local cross-origin `/pick` and `/embed`).

### Synthetic Fixture Verification

Start the synthetic fixture server in one terminal and run Chromium / Vlmkit checks in another:

```sh
pnpm --dir vaultbrowser exec vite --config fixtures/vite.config.ts --host 127.0.0.1 --port 3023
```

```sh
pnpm --dir vaultbrowser verify:fixture
node vaultbrowser/scripts/verify-device-keys.mjs
node vaultbrowser/scripts/verify-key-funding.mjs
node vaultbrowser/scripts/verify-parity.mjs
wikibrowser/node_modules/.bin/vlmkit check integrity 'http://127.0.0.1:3023/?state=opened'
wikibrowser/node_modules/.bin/vlmkit check copy 'http://127.0.0.1:3023/?state=opened' --manifest vaultbrowser/fixtures/copy.txt
wikibrowser/node_modules/.bin/vlmkit scan scroll 'http://127.0.0.1:3023/?state=opened'
wikibrowser/node_modules/.bin/vlmkit scan handlers 'http://127.0.0.1:3023/?state=opened'
wikibrowser/node_modules/.bin/vlmkit check interactions 'http://127.0.0.1:3023/?state=opened'
```

The Vite fixture substitutes key acquisition and actor transport with an in-memory actor while running real client encryption; it does not replace PocketIC Wasm or real-II browser acceptance. Local verification scripts never deploy, modify DNS, or transfer live funds.

### Real-II and Payment Acceptance

For full local Internet Identity, canister, team-embed, and shared-payment acceptance commands, see [Vault validation](../docs/vault/validation.md).

Quick reference:

```sh
# Full real-II browser acceptance
node pocketic-tests/scripts/run-vault-browser-acceptance.mjs

# Local shared-payment acceptance (II, local ICRC signer popup, Plug fixture)
node pocketic-tests/scripts/run-vault-browser-acceptance.mjs --payments-only

# Official pinned ICRC ledger + wallet funding tests (requires PocketIC 16.1.0)
POCKET_IC_BIN=/absolute/path/to/pocket-ic pnpm --dir pocketic-tests test:vault-funding-ledger
pnpm --dir pocketic-tests build:vault-current
POCKET_IC_BIN=/absolute/path/to/pocket-ic node --test pocketic-tests/integration/vault-wallet-funding.test.mjs
```
