# Dedicated Kinic Vault

Vault deploys independently of Wiki. Wiki only links to `https://vault.kinic.xyz`; the browser constructs its own authenticated actor for the dedicated Vault canister.

## Access and retained features

Sign in with Internet Identity, select or create a Vault, then use its encrypted documents. There is no additional Vault passkey, unlock credential, backup or independent recovery. Losing Internet Identity access permanently loses Vault access unless Internet Identity itself is recovered. This disclosure appears before Create Vault.

Notes, private Markdown preview, saved-credential content, attachments, local search, version history/downloads, ordinary document deletion, document-and-history purge, entire-Vault purge and interrupted-upload cleanup remain available. The browser uses the II-only v3 document format. Previous recovery/backup packages, tools and UI have been removed.

A create retry retains the same operation and Vault ID in RAM. If key retrieval fails after creation, select that existing Vault or use Retry opening Vault. Refresh preserves the selected root, draft and pending creation. Pending/Deleting headers can be selected for cleanup without a key request. Resume save retransmits the pending encrypted action; Cancel save reconciles the upload before cancellation. Close Vault clears private state but leaves II signed in. Sign out ends authentication.

AuthClient 5.0.0 retains the existing eight-hour delegation TTL and five-minute idle timeout. While an identity is exposed, the provider checks delegation validity locally every second, independently of activity. Expiry removes the identity before asynchronous SDK logout finishes. Login waits for logout storage removal. New identity objects rebuild the actor even if their principal text matches.

Private documents, roots, draft inputs, File references, editor undo state and owned Blob URLs are scoped to the private session. Close, switch, logout, expiry and unmount fence late operations and clear private views. Hidden tabs close after one minute. Explicit clipboard copies and downloaded files are not cleared, and this does not promise physical RAM erasure. II's own delegation storage remains managed by its SDK.

## Build and verify

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

The browser build is embedded in the dedicated canister's certified responses. Mainnet never fetches a replacement root key. Its II derivation origin is `https://<vault-canister-id>.icp0.io`; the default provider is `https://id.ai`. Local certified configuration requires explicit `ICP_ENVIRONMENT=local-vault`, `VAULT_LOCAL_ORIGIN`, `VAULT_LOCAL_HOST` and `VAULT_LOCAL_II` values. Use the canister gateway for actual II acceptance; Vite is a synthetic fixture, not a certified deployment.

For the owned synthetic browser gate, in separate terminals:

```sh
pnpm --dir vaultbrowser exec vite --config fixtures/vite.config.ts --host 127.0.0.1 --port 3023
node vaultbrowser/verify-fixture.mjs
wikibrowser/node_modules/.bin/vlmkit check integrity 'http://127.0.0.1:3023/?state=opened'
wikibrowser/node_modules/.bin/vlmkit check copy 'http://127.0.0.1:3023/?state=opened' --manifest vaultbrowser/fixtures/copy.txt
wikibrowser/node_modules/.bin/vlmkit scan scroll 'http://127.0.0.1:3023/?state=opened'
wikibrowser/node_modules/.bin/vlmkit scan handlers 'http://127.0.0.1:3023/?state=opened'
wikibrowser/node_modules/.bin/vlmkit check interactions 'http://127.0.0.1:3023/?state=opened'
```

The UI fixture substitutes key acquisition/context refresh and uses an in-memory actor with real document encryption. Browser unit tests use the current client and mocked root verification. Neither establishes actual II, vetKD or current-Wasm acceptance. The handlers inventory reports React's root delegated dragstart and CodeMirror's contenteditable dragstart as not-draggable suspects; no draggable attributes or suppressions are added to hide them. The explicit Chromium gate covers keyboard editing, preview, refresh preservation, history download and private DOM/editor undo/password/Blob cleanup.

`verify-acceptance.mjs` and `fixtures/acceptance-readback.ts` remain the separate Task3 acceptance boundary. They still reference the retired passkey/recovery protocol and must be replaced before use; they are not current II-only validation commands.

## Funding and capacity

Production funding remains disabled pending authoritative ledger reconciliation. Existing payment status is readable; do not send replacement payments for uncertain records. Only an explicitly configured synthetic-test-only build enables the test funding controls. `get_config` now supplies the key name and minimum cycles; RP/origin registration is not part of Vault authorization.

Shared storage capacity is separate from prepaid balance. Owner cleanup, including interrupted-upload cancellation and whole-Vault deletion, remains available with zero prepaid balance. No deployment, DNS change, production mutation or real-funds transfer is part of these checks.
