# Vault Protocol (II-only)

See [Vault overview](README.md) for repository layout, [team access](team-access.md) for the shared wire contract, [operations](operations.md) for trust and expiry limits, and [validation](validation.md) for reproducible test commands.

## Wire Contracts

The authoritative wire API is [`vault.did`](../../crates/vault_canister/vault.did). The browser uses the generated [Vault contracts](../../packages/vault-candid/index.d.ts) and [`VaultClient`](../../packages/vault-client/src/api.ts).

- **Owner methods** bind the authenticated IC caller to its own Vaults.
- **Shared methods** look up the recorded owner by Vault ID, check the caller's role, and use the recorded owner for v3 encryption and billing.

Both owner and shared protocols use the same document format (`v3`).

## Vault Creation and Key Derivation

Creation accepts only a 16-byte operation ID. The server allocates a never-reused 16-byte Vault ID from its persistent positive operation serial (zero-extended big-endian `u128`), and pins a 32-byte random nonce and the vetKD public key in the header. Retry the same operation after an uncertain response; pending creation and completed receipts preserve the assigned identity.

Key acquisition accepts that Vault ID, a 16-byte operation ID, and a 48-byte transport public key. Retry with the same transport secret/public pair. The client checks the authenticated current header, the vetted network master key, the reply input/public key, and the decrypted vetKey before deriving the root key.

- **vetKD context**: `kinic-vault/ii-only/v1`
- **vetKD input**: concatenation of five fields, each prefixed by an unsigned 32-bit big-endian byte length:
  1. raw canister principal
  2. raw owner principal
  3. 16-byte Vault ID
  4. 32-byte nonce
  5. UTF-8 key name
- **Symmetric root**: 32-byte root derived with `kinic-vault/root/v3`

## Document Format (`v3`)

Only document format `v3` is supported; there is no legacy metadata reader.

Document AES-GCM associated data concatenates six length-prefixed fields:

1. `kinic-vault/document/v3`
2. the complete vetKD input
3. 16-byte object ID
4. 64-bit big-endian revision
5. usage string
6. 32-bit big-endian chunk index

Encrypted metadata contains `{ metadata, plaintext_length, chunk_count }`. Authenticated extent must agree with the manifest, chunk/hash/nonce counts, and final plaintext length.

Listing decrypts metadata only and never reads document chunks; opening a document fetches and decrypts its contents on demand.

## Mutations, Uploads, and Deletion

`mutate({ operation, action })` atomically stores each successful effect, request digest, and reply. Replays with the same operation ID and payload succeed for 24 hours; a changed payload under the same operation ID conflicts.

Supported `Action` variants in [`vault.did`](../../crates/vault_canister/vault.did):

- `BeginRevision`, `PutChunk`, `CommitRevision` (multi-chunk upload)
- `SaveInline` (single-call inline save)
- `RenameVault` (owner-only plaintext display name update)
- `DeleteObject`, `PurgeObject`, `CancelUpload`, `DeleteVault`, `Collect`

`BeginRevision`'s inner `operation` is the upload ID and differs from the outer mutation operation ID. Prepaid admission reserves completion receipts and capacity. Unknown network outcomes must be reconciled or retried with their original IDs. Ordinary request replay lives in `operations`; upload-ID reconciliation lives in typed `upload_outcomes` and cannot interpret an ordinary delete result as a committed upload.

- **Ordinary deletion (`DeleteObject`)**: appends a tombstone and retains accessible history.
- **Purge (`PurgeObject`)**: hides all history and leaves a permanent object fence while bounded GC reclaims ciphertext.
- **Cancel upload (`CancelUpload`)**: preserves one job across batches and reclaims encrypted chunks incrementally.
- **Delete Vault (`DeleteVault`)**: physically removes the Vault row after bounded cleanup; there is no permanent Vault tombstone.

The three-Vault owner limit includes `Pending` and `Deleting` rows; completed deletion restores capacity. Financial journals and operation receipts retain their independent lifetimes; after the final receipt expires, a missing Vault returns `NotFound`. Cleanup uses authenticated owner access and remains available at zero balance.

## Session and Context Isolation

The Vault header binds canister, owner, Vault ID, nonce, key name, and public key, while `sequence` (and the optional plaintext display `name`) are mutable. Switching context invalidates pending key attempts, in-memory roots, and private callbacks. Browser session guards provide local lifecycle protection only; ordinary logout cannot revoke a retained session signing key with its still-valid II delegation.

## Wiki References and Picker

A standalone paragraph with the exact Markdown spelling `[非公開資料](https://vault.kinic.xyz/embed/<vault-id>/<object-id>)` identifies a private document. Each ID is 16 bytes encoded as 32 lowercase hexadecimal digits. The Wiki article, history, and static output contain only the opaque reference; its generic label carries no document metadata.

The Wiki editor opens the trusted Vault origin at `/pick`:

1. The picker sends `{"type":"kinic-vault-picker-ready"}`.
2. The editor replies with `{"type":"kinic-vault-picker-connect"}`. Both sides verify the exact window and origin.
3. When the user selects an accessible document, Vault rechecks access and sends `{"type":"kinic-vault-selection","vault":"<vault-id>","object":"<object-id>"}`.
4. The editor appends the Markdown reference to the current draft.

In interactive preview, opening the reference creates a Vault-origin iframe. Vault obtains its own II delegation, checks current authorization, derives the owner-bound root, and renders the document. Credential details require an explicit reveal action and attachments require an explicit download action. If iframe sign-in is unavailable, the frame offers top-level Vault sign-in and a retry.
