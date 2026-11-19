# Dedicated Kinic Vault

Vault deploys independently of Wiki. Wiki only links to `https://vault.kinic.xyz`; the browser constructs its own authenticated actor for the dedicated Vault canister.

Set Wiki's `VITE_PRIVATE_VAULT_URL` to the published Vault URL to show **Private Vault** below **Dashboard** in desktop and mobile navigation. Leave it empty until that deployment is available. The link opens in the same tab. For local testing, set it to the local Vault gateway URL and build Vault with `VITE_WIKI_URL=http://127.0.0.1:3100/dashboard` so **Back to Wiki** returns to the local Wiki. Vault defaults to the production Wiki dashboard when `VITE_WIKI_URL` is unset.

## Access and retained features

Sign in with Internet Identity, select or create a Vault, then use its encrypted documents. There is no additional Vault passkey, unlock credential, backup or independent recovery. Losing Internet Identity access permanently loses Vault access unless Internet Identity itself is recovered.

Notes, private Markdown preview, saved-credential content, attachments, local search, version history/downloads, ordinary document deletion, document-and-history purge, entire-Vault purge and interrupted-upload cleanup remain available. The browser uses the II-only v3 document format. Previous recovery/backup packages, tools and UI have been removed.

**Show version history** lists saved revisions. **View revision** displays that revision read-only; **Return to latest version** resumes the current document. The common **Download document** action downloads the displayed saved revision. Historical views cannot overwrite the latest version.

Each document card has an **…** menu for **Delete document** (history retained) and **Permanently delete document and history** (irreversible). Both open a confirmation dialog naming the target and require the exact text `delete`. Document deletion is available only from that card menu, including when another document is open. Permanent deletion remains available with zero prepaid balance.

Each Vault card also has an **… → Rename Vault** action. Names are owner-only display metadata stored in plaintext on the service, so they appear before opening the Vault and on other devices. Documents remain encrypted. Names allow up to 64 characters, survive upgrades, and do not affect the root key or require a key retrieval. Existing Vaults keep the `Vault 1` style fallback until renamed. Renaming is an ordinary prepaid update with optimistic sequence checks and exact-operation retry. Deploy the backend accepting `RenameVault` before publishing this UI; the optional name fits inside the existing prepaid header allocation without changing the SQL schema.

Mutation receipt identities use a frozen original Candid shape for existing actions and independent domains for new actions. The service also recognizes receipts written by the interim ten-variant implementation that first added `RenameVault`, without rewriting their hashes. Payload, owner, expiry and pending-operation generation checks still apply. Compatibility tests pin historical hashes; the local upgrade check replays the original client's rename, begin, chunk, commit and deletion requests after upgrading.

A create retry retains the same operation and Vault ID in RAM. If key retrieval fails after creation, select that existing Vault or use Retry opening Vault. Refresh preserves the selected root, draft and pending creation. Pending/Deleting headers can be selected for cleanup without a key request. Resume save retransmits the pending encrypted action; Cancel save reconciles the upload before cancellation. Close Vault clears private state but leaves II signed in. Sign out ends authentication.

Storage maintenance and permanent Vault deletion are available from **Settings**. Returning to the workspace preserves the open Vault and unsaved draft. Deletion requires typing the selected Vault name. Expired uploads and retired history are also collected automatically; **Free up unused storage** runs this maintenance manually. Saved browser keys are removed from Settings as well.

The workspace, picker and embed all use AuthClient 5.0.0 with an eight-hour delegation TTL and a 30-minute idle timeout. While an identity is exposed, the provider checks delegation validity locally every second, independently of activity. Expiry removes the identity before asynchronous SDK logout finishes. Login waits for logout storage removal. New identity objects rebuild the actor even if their principal text matches. SDK logout removes this browser's session; it does not revoke a retained session signing key and its still-valid II delegation. That retained signing identity remains usable until its signed expiry (up to the requested eight hours).

Private documents, roots, draft inputs, File references, editor undo state and owned Blob URLs are scoped to the private session. Close, switch, logout, expiry and unmount fence late operations and clear private views. Switching tabs does not close the Vault; hidden tabs use the same 30-minute inactivity limit. Explicit clipboard copies and downloaded files are not cleared, and this does not promise physical RAM erasure. II's own delegation storage remains managed by its SDK.

## Device keys and initial credit

Verified non-extractable AES-GCM root keys are saved in this browser's IndexedDB automatically. Close, logout and idle expiry wipe active views and memory references but retain the saved handles. Opening again authenticates and validates the current Vault header, shared grant and anchored public key before reusing a key. The device cache is scoped to the authenticated caller and canister; shared roots retain the immutable owner context. No additional passkey is required; II logout does not cryptographically protect these browser-local handles from code running on this origin. **Delete saved keys from this browser** removes the current principal's handles and closes other tabs; it does not delete Vault documents. When persistence is unavailable, the app keeps keys in memory and explains that a future session needs a paid retrieval.

New Vault principals receive 10B cycles once, plus one service-sponsored management key retrieval fee, through an explicit authenticated account-initialization update. Normal execution and storage still use the 10B operating credit. Balance queries never allocate or grant. Migration from supported pre-benefit layouts permanently excludes existing account holders, Vault owners and payment participants from new benefits, without reducing existing balances or rewriting historical grants. Existing benefit-era grant and subsidy consumption is preserved. Receipts survive empty balances, resource deletion and upgrades. Wiki keeps its separate 10B initial credit using the same transactional receipt helper. Permanent grant and subsidy receipts retain their own admission limits.

Deploy the schema14 backend before serving UI that calls shared, rename, initialization or key-price endpoints. Earlier binaries cannot reopen the migrated store. Rollback requires a separately validated schema14-compatible build; do not downgrade or reinstall the store. See [operations](../docs/vault/operations.md) for supported historical contracts and rollout order.

A saved key avoids further vetKD retrieval fees on this browser. A new browser or deleted key needs a retrieval at the runtime-reported price, using the owner's remaining first-key subsidy when eligible; shared access uses the stored owner's credit. Funding stays inline when needed.

## Build and verify

From the repository root:

```sh
pnpm --dir vaultbrowser test
pnpm --dir vaultbrowser typecheck
pnpm --dir vaultbrowser build
pnpm --filter @kinic/vault-client test
node packages/vault-client/scripts/generate-contracts.mjs --check
node vaultbrowser/scripts/verify-device-keys.mjs # running synthetic fixture URL; actual IndexedDB/Chromium
node scripts/check-vault-boundary.mjs
wikibrowser/node_modules/.bin/oxlint --deny-warnings vaultbrowser/src vaultbrowser/fixtures/main.tsx vaultbrowser/fixtures/network.ts packages/vault-client/src packages/vault-client/test
```

The browser build is embedded in the dedicated canister's certified responses. Mainnet never fetches a replacement root key. Its II derivation origin is `https://<vault-canister-id>.icp0.io`; the default provider is `https://id.ai`. Local certified configuration requires explicit `ICP_ENVIRONMENT=local-vault`, `VAULT_LOCAL_ORIGIN`, `VAULT_LOCAL_HOST` and `VAULT_LOCAL_II` values. Set `VAULT_LOCAL_WIKI_ORIGIN` to the exact local Wiki loopback HTTP(S) origin to exercise framing and the cross-origin picker. A local build without this value serves embeds for top-level viewing. Production certifies the embed policy for `https://wiki.kinic.xyz`. Use the canister gateway for actual II acceptance. The Vite fixture serves synthetic data.

For the owned synthetic browser gate, in separate terminals:

```sh
pnpm --dir vaultbrowser exec vite --config fixtures/vite.config.ts --host 127.0.0.1 --port 3023
pnpm --dir vaultbrowser verify:fixture
wikibrowser/node_modules/.bin/vlmkit check integrity 'http://127.0.0.1:3023/?state=opened'
wikibrowser/node_modules/.bin/vlmkit check copy 'http://127.0.0.1:3023/?state=opened' --manifest vaultbrowser/fixtures/copy.txt
wikibrowser/node_modules/.bin/vlmkit scan scroll 'http://127.0.0.1:3023/?state=opened'
wikibrowser/node_modules/.bin/vlmkit scan handlers 'http://127.0.0.1:3023/?state=opened'
wikibrowser/node_modules/.bin/vlmkit check interactions 'http://127.0.0.1:3023/?state=opened'
```

The UI fixture substitutes key acquisition/context refresh and uses an in-memory actor with real document encryption. Browser unit tests use the current client and mocked root verification. Neither establishes actual II, vetKD or current-Wasm acceptance. The handlers inventory reports React's root delegated dragstart and CodeMirror's contenteditable dragstart as not-draggable suspects; no draggable attributes or suppressions are added to hide them. The explicit Chromium gate covers keyboard editing, preview, refresh preservation, history download and private DOM/editor undo/password/Blob cleanup.

Run `node pocketic-tests/scripts/run-vault-browser-acceptance.mjs` from the root for actual II/canister acceptance. The launcher creates fresh local infrastructure with isolated CLI settings, uses the certified production entry and a synthetic ledger, and tears down only its own processes. The inspector bundle is served through owned browser interception and is excluded from production assets. See [validation](../docs/vault/validation.md) for commands, artifacts and limits.

## Funding and capacity

Production KINIC funding supports authoritative user-requested ledger reconciliation. Existing payment status is readable; do not send replacement payments for uncertain records. Production accepts only the pinned KINIC ledger; a separately labelled synthetic-test-only build permits disposable test ledgers. `get_config` now supplies the key name and minimum cycles; RP/origin registration is not part of Vault authorization.

Shared storage capacity is separate from prepaid balance. Owner cleanup, including interrupted-upload cancellation and whole-Vault deletion, remains available with zero prepaid balance. No deployment, DNS change, production mutation or real-funds transfer is part of these checks.

Document lists decrypt metadata only. Typing in the local search field filters titles without reading note bodies. Use **Search note contents** to read notes transiently and include matching bodies; the browser keeps only matching object IDs and discards them when the query/list changes or the Vault closes. There is no persistent full-text index or cache.

Private Vault views also close after 30 minutes of inactivity. Switching tabs does not shorten that timeout; returning to a tab rechecks expiry even if its timers were throttled. Pointer movement, clicks, typing and scrolling count as activity.


### Credit and key-fee admission

Creation includes the owner share of the current default key retrieval price (zero while the first-key subsidy is available) plus minimum execution credit for the create and derive updates. Existing Vaults use their own header key name for the preflight price, so changing the default key does not misprice an older Vault. The client authorizes only a new key operation: cached keys and exact interrupted-request replays retain their original behavior. When a missing key cannot be funded, its selected Vault shows funding inline and retries that same Vault after credit is added.

The balance refreshes after successful and failed operations; generation and request ordering fence obsolete responses. Initial free credit uses the same arithmetic admission as purchases, including pending paid credits and possible cycle refunds. If no headroom remains, the grant stays unclaimed, account initialization still permits payment recovery, and a later account refresh can retry the grant.

With the synthetic fixture server running, `node vaultbrowser/scripts/verify-key-funding.mjs` checks the mobile insufficient-credit → inline funding → same-Vault retry flow. It simulates credited funds and never makes a real purchase.


### First-key sponsorship

The key-price query returns `fee` (the actual management fee), `owner_fee` (zero while the authenticated principal has its first-key subsidy), and `first_key_free`. The UI refreshes this status after operations, so spending the free retrieval cannot leave another creation incorrectly enabled on 10B. Once the subsidy is used, new retrievals need paid credit; saved keys and exact in-session replay of a lost response continue to work.

The protected receipt progresses from available to reserved to used, keyed by the server-issued operation token. A completed zero-cost failure restores eligibility; a charged failure consumes it. Cancellation and unknown submitted work keep it reserved or consumed until authoritative settlement. Upgrade-orphan recovery accounts conservatively for the attached fee. The receipt survives Vault deletion, device-key removal and journal GC. The service covers management fees only; ordinary execution/storage remain charged to the operating credit. Existing v9/v10 users retain their balances and historical grant amounts and do not receive another subsidy.


### SPA navigation and draft protection

The embedded React/Vite application uses TanStack Router for `/`, `/settings` and `/help`, including direct loads and browser history. The private client and editor remain mounted while visiting settings or help; routes contain no private document or Vault identifiers. Hosting stays in the same Vault canister without SSR.

Unsaved edits require confirmation before manual document/Vault changes, closing Vault, signing out or removing browser keys. Reload/close uses the browser's native leave prompt. Automatic lock and expiry cancel pending confirmations and wipe immediately. Both document deletion choices are in each document card’s … menu and require typing `delete`; storage cleanup and full Vault purge are under settings.

The startup shell provides loading, noscript and reload recovery. Import/render failures show generic recovery text, and failed initial connections offer retry. Password copying reports success or failure only for the active credential.

With the synthetic fixture server running, `node vaultbrowser/scripts/verify-parity.mjs` checks routes/history, retained drafts, discard cancellation, native reload protection, lock cancellation, help and unknown routes. This uses synthetic encrypted documents and does not perform a real payment or Internet Identity acceptance run.
