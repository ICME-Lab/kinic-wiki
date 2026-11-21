# Vault Operations and Trust Boundaries

See [Vault overview](README.md), [protocol](protocol.md), [accounting and capacity](accounting-capacity.md), and [validation](validation.md).

## Access Model and Recovery

Sign in with Internet Identity, then create or select a Vault. There is no additional Vault passkey, recovery secret, backup, import, or export protocol. Losing access to Internet Identity permanently loses Vault access unless Internet Identity itself is recovered. This disclosure appears before Vault creation. Saved credentials are encrypted document content, not Vault unlock credentials.

The dedicated canister records the creator as owner. For team access, it resolves the owner by Vault ID and checks the authenticated caller's grant. Private content and key reads are authenticated update calls. The client verifies vetKD against the network master key and the pinned header before installing a non-extractable browser root. Sequence changes do not change the root.

## Trust Boundaries and Origin Isolation

Vault JavaScript, its canister, Internet Identity, and their authorized controllers remain trusted. A compromised session signing key with a valid II delegation can exercise the owner's Vault API and derive its key; there is no independent Vault factor.

- **AuthClient 5.0.0** requests an 8-hour delegation and enforces a 30-minute idle logout in the workspace, picker, and embed; the UI checks delegation validity every second even during activity.
- **Logout is not server-side revocation**: logout deletes local SDK storage and clears private application state, but **does not revoke a retained session signing key together with its still-valid II delegation**. The replica rejects it only after its signed expiry. Do not describe local sign-out, a closed tab, or a client lock as server-side credential revocation.
- **Wiki isolation**: Wiki and Vault have separate canisters, databases, and origin-derived principals. Updating Wiki does not update Vault; use separate controller permissions where separate updater trust is required.
- **Canonical origins**:
  - Derivation origin: `https://<vault-canister-id>.icp0.io`
  - Allowed application origin: `https://vault.kinic.xyz`
  - Identity provider: `https://id.ai`
  - **Never add the Wiki origin to Vault alternative origins.**
- **Internet Identity metadata**: The canister serves certified `/.well-known/ii-app-metadata` (name, description, logo path), `/.well-known/ii-app-logo.png`, and `/.well-known/ii-alternative-origins` with `Access-Control-Allow-Origin: *` so Internet Identity can read them cross-origin and display Kinic Vault on its sign-in screen.
- **Framing and picker**: Only the Vault `/embed` route family permits framing by the canonical Wiki origin (`https://wiki.kinic.xyz`). The `/pick` window verifies the opener and its origin. Local HTTP configuration and root-key fetching belong only to disposable test builds.

## Browser Session and Device Keys

The browser prepares validated certified sign-in configuration alongside AuthClient initialization. Sign-in remains disabled until both are ready; clicking invokes SDK login immediately so popup creation retains browser user activation. Configuration failure requires a reload. Listings decrypt metadata only; opening a document fetches and decrypts its contents. Authenticated metadata binds the complete plaintext length and chunk count.

- **In-session retries**: Creation retains one operation/Vault ID in RAM for uncertain replies; refresh preserves that retry. If key acquisition fails after the header was created, retry opening that header instead of creating another Vault. A root is never relabelled with a changed owner, canister, Vault, nonce, key name, or public key; a missing or changed target closes its private context.
- **Interrupted saves**: Interrupted saves keep encrypted request bytes and their operation/upload IDs in the current session. **Resume save** retransmits the exact pending action; **Cancel save** reconciles actual upload status before bounded cleanup. Reload or lock discards the local job; the owner can list and cancel orphaned encrypted uploads. No plaintext or interrupted-save job is persisted across reloads. Receipt replay is guaranteed for 24 hours. Exact cleanup retries replay the previous result; the next batch uses a fresh outer operation and the same cleanup job.
- **View teardown**: Lock, logout, expiry, idle timeout (30 minutes across all three views; hiding a tab does not shorten it), and unmount clear application references, DOM, `File` selections, editor contents, and undo history, and revoke owned Blob URLs. Switching owners or Vaults clears the previous private view and fences late callbacks. **Close Vault** keeps II signed in; **Sign out** clears app authentication. JavaScript garbage collection does not guarantee physical RAM erasure, and explicit clipboard copies or downloaded files remain under the user's control.
- **Cross-tab coordination**: Explicit **Sign out** clears related Vault views within the same browser storage partition via a random UUID stored in `localStorage` at `kinic-vault-logout` (prefixed with `pending:` while the SDK removes its cached delegation). Sign-out notifications stay on the Vault origin. On browsers with Web Locks, an accepted login is published to standard IndexedDB SDK records and coordinated with deletion so the delegation stays alive while another authenticated view uses it; without Web Locks, logins last for the current view only.
- **Device-key cache**: Verified non-extractable AES-GCM root handles are saved in IndexedDB (separate from II's delegation database) under the canister and authenticated caller, bound to the immutable owner context and public key. Closing, signing out, and idle expiry retain these handles; reopening authenticates and revalidates current access before reuse. A shared member's new key request uses the recorded owner's first-key subsidy (when eligible) or prepaid credit. **Delete saved keys from this browser** removes the caller's handles and advances a shared epoch to fence older views and in-flight writes. Access denial or a changed immutable header evicts the target Vault's handle. Persistence failure falls back to memory (a later paid retrieval may be needed). Plaintext, raw keys, and DEKs must never enter persistent storage, URLs, analytics, or logs. Origin code can use saved handles; signing out does not cryptographically protect them from that origin.
- **Member management without key retrieval**: Owners can open **Actions for Vault → Manage members** on a Vault card to list and remove grants without opening its root or paying for a key request, including after a key-service failure. Adding or changing a grant remains subject to spending and capacity checks.

## Schema 14 and Upgrades

Fresh installations create **schema 14**. The backend validates and migrates supported historical layouts in place:

- owner schemas 8, 9, and 10
- grant-bearing schema 10
- team schema 11
- subsidy schemas 11 and 12
- combined schema 13

Migration retains owner headers, encrypted documents, pending-upload provenance, grants, accounting, subsidy consumption, and mutation receipts. Unknown or hybrid layouts are rejected atomically.

**Rollout and rollback rules:**

1. Upgrade the Vault backend **before** publishing any UI that calls shared, rename, account-initialization, or key-price methods. Existing owner-only clients continue to work.
2. Earlier binaries cannot reopen a migrated schema 14 store.
3. Rollback requires a separately validated schema-14-compatible build; **do not reinstall or downgrade the store**.
4. Retain source and Wasm provenance for every release.

## Capacity and Cleanup Bounds

Each owner is limited to 3 Vaults, 100 MiB of current plaintext per Vault, and 200 MiB of charged usage. The UI limits notes and credentials to 256 KiB and attachments to 10 MiB. History, ciphertext, pending operations, and reservations also consume quota. Monitor actual stable memory and cycle headroom as usage grows (Vault runs on SQLite VFS within IC canister limits).

- **Emergency key capacity**: Fresh key acquisition has up to 16 emergency receipts per owner (retained 24 hours) when content or ordinary receipt slots are full. Exact retries reuse their slot; exhaustion refuses new key operations until capacity is reclaimed. Normal key rates, execution credit, and the canister's minimum cycle reserve still apply.
- **Upload reservations and cleanup**: Admission reserves completion capacity for each upload's chunks and commit so admitted work can finish at the owner quota (execution still requires credit). Owner cleanup remains available at zero credit and full capacity using resource-specific prepaid cleanup receipts. Cancellation removes one encrypted chunk per batch; document purge immediately hides history and fences object-ID reuse before bounded collection; whole-Vault deletion removes the Vault row after bounded cleanup and restores Vault capacity without reusing IDs. Timer GC persists a round-robin owner cursor through upgrades so a no-work owner cannot starve another owner's expired work.

See [accounting and capacity](accounting-capacity.md) for full limits and formulas.

## Production Funding and User-Requested Reconciliation

Production builds support ICRC-2 KINIC purchases **only** through the pinned KINIC ledger `73mez-iiaaa-aaaaq-aaasq-cai`. Certified configuration reports `fundingMode: production`; builds with the `synthetic-funding-test-only` Cargo feature, synthetic ledgers, and injected state fixtures are separately labelled, non-deployable test artifacts. The controller selects the recipient and conversion rate; each accepted quote pins that configuration and a freshly obtained ledger fee. The spender is the Vault canister, not Wiki.

Before any debit, Vault durably records its ledger search start and exact transfer identity. A failed tip lookup is known-unsent and retryable. Unknown transfer outcomes retain their original amount, fee, memo, and creation time — **never send a replacement payment or invent compensating credit** to resolve uncertainty.

To reconcile an uncertain payment:

1. Select the saved payment in the UI and choose **Check ledger history** (calls `reconcile_purchase`).
2. Each authenticated update scans at most 100 blocks, following only archive callbacks supplied by the pinned ledger.
3. The UI runs at most 10 updates per click, displays progress, and supports stop/resume (stopping does not cancel or undo a payment). There is no periodic scanner.
4. Confirmation atomically records `Paid` and credits the beneficiary once; absent, malformed, or unavailable evidence leaves the payment pending.

## Release Build Provenance

Build the backend Wasm without browser assets using standard `cargo build`. For distribution builds that embed the certified browser bundle, use the release entrypoint:

```sh
bash scripts/build-vault-canister.sh
```

This script builds `vaultbrowser`, compiles `vault-canister` with `--features embedded-assets --release --locked`, attaches `candid:service` metadata from `crates/vault_canister/vault.did`, and runs `scripts/check-vault-release.mjs` to verify build provenance, HTTP/reconciliation exports, and the absence of fixture exports. Production packaging rejects local-origin environment variables, synthetic funding, and `RUSTFLAGS` / `CARGO_ENCODED_RUSTFLAGS` overrides. Local acceptance assets are built separately and cannot pass the release check.
