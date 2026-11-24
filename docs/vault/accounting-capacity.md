# Vault Accounting and Capacity

See [Vault overview](README.md) for architecture and [operations](operations.md) for deployment and reconciliation procedures.

## Production Funding

Production funding uses the pinned KINIC ledger (`73mez-iiaaa-aaaaq-aaasq-cai`) and user-requested authoritative reconciliation. Default builds reject foreign ledger configuration before transfer dispatch. Existing journals, holds, balances, and valid late callback settlement remain intact. Only an explicitly non-deployable `synthetic-funding-test-only` build permits purchases against synthetic ledgers.

An external wallet (OISY or Plug) signs only `quote_purchase` and the ledger `icrc2_approve`. The quote fixes the payer, beneficiary, amount, and recipient, and the approval bounds the debit. The signed-in beneficiary then reads that payer's payments with `beneficiary_payments` and `beneficiary_payment_status`, and submits the quote with `beneficiary_pay_purchase`. It can also withdraw an unpaid quote with `beneficiary_cancel_quote` and run ledger reconciliation with `beneficiary_reconcile_purchase`; neither sends a transfer. These methods return only payments whose beneficiary is the caller. Another principal gets no records and `NotFound`. `pay_purchase` remains available to the payer. The browser opens OISY in a tab for each signature and closes it when that signature completes.

## Storage Quotas and Row Bounds

Vault stores enforce:

- **3 Vaults per owner** (including `Pending` and `Deleting` rows)
- **100 MiB of current plaintext per Vault**
- **200 MiB of charged usage per owner**

Schema 14 removes the shared 200 MiB logical quota, the Vault-specific 4 GiB SQLite page ceiling, and shared row admission limits for content and journals. Logical and physical capacity differ: the owner maximum is a logical quota, while available stable memory and cycles determine how many owners can reach it.

`get_quota` reports owner and Vault storage. `global_capacity` reports aggregate logical charges and the current accounting reservation. Legacy fields retain their Candid types: `limit` returns `u64::MAX`, `overcommitted` returns `false`, and `overage` returns `0`, indicating that Vault admission has no shared byte quota. SQLite page and index overhead, stable-memory VFS metadata, and Wasm heap usage are outside logical accounting.

Whole-row guards bound:

- Payments and fee leases: **4,096 bytes**
- Account and reservation rows: **512 bytes**
- Key-flight rows: **256 bytes** (charged as 4,096 bytes to the owner, up to 512 retained per owner)
- Global setting slots: **7 × 8 KiB**
- Concurrent operations: up to **8 fee lookups** and **8 reconciliation scans**
- Wallet records: up to **16 funding or Wiki bridge records** per wallet

Vault also retains separate initial-grant and key-subsidy eligibility guards and a 10,000-entry audit retention policy.

## Prepaid Accounts and Mutation Admission

Each authenticated caller owns one prepaid account. Cycle reservations store this owner once; refunds and execution checkpoints settle against the same account even after new work is disabled. Payment wallets and beneficiaries remain separate identities.

Ordinary mutations (including `DeleteObject`) replay exclusively through `operations`. Its named admission classes are `Ordinary`, `Cleanup`, `ResourceCleanup`, and `ProtectedKey`; one policy controls class counts, result limits, and usage charges. `upload_outcomes` separately retains tagged `Committed` revisions or `Cancelled` Vault/job pairs under upload IDs and their original begin digest. These lifetimes differ from mutation IDs. Expired pending uploads report `Expired` until bounded GC produces the same `Cancelled` outcome as explicit cancellation.

An admitted upload reserves ordinary receipt slots and bytes for each distinct chunk and commit. Pending operations reserve 128 KiB and release unused room when their encoded result is committed. Exact operation retries reuse the same receipt; a fresh-ID duplicate chunk consumes ordinary capacity instead of another upload's reserved completion room. Admitted chunks and commit can use their reservations at the owner quota, while new work still requires execution credit.

## Cleanup and Emergency Key Capacity

Cleanup of admitted uploads, documents, and Vaults uses resource-specific 512-byte completion credits. Resource-backed cleanup receipts are charged to previously admitted resources, separately from the 512-row owner limit for unreserved cleanup receipts. Cancellation preserves its job across batches; each batch removes at most one ciphertext chunk. Purge immediately fences all object history; collection reclaims retired rows in bounded batches. Zero-credit and full-capacity cleanup remain possible. No-work `Collect` returns `NotFound` without creating a receipt, and exact retries replay the original result. Receipt retention is 24 hours.

Vault IDs come from the persistent operation serial. Completed bounded Vault deletion physically removes the Vault row, so there is no accumulating Vault tombstone or ID-reuse risk. Financial journals and operation receipts retain their independent bounded lifetimes.

Fresh key acquisition first uses ordinary operation admission. If content capacity or ordinary receipt slots are exhausted, it can use up to **16 retained protected operations per owner**, each bounded to 2,048 bytes with at most 1,024 encoded result bytes. The charge fits within the owner quota. Both admission modes share the 100/day owner and 1,000/day global key limits, 1/8 in-flight bounds, cycle budget, and positive-credit requirements. Exact retries retain their stored class, digest, and result for 24 hours; changed requests conflict. Exhausting the emergency pool refuses new key operations until capacity is reclaimed. This provides bounded fresh access at full content capacity, not unlimited full-capacity reopens.

Each key-flight row carries the 16-byte target Vault, token, phase, and generation. Indexed collection removes up to 128 eligible settled key rows per batch and preserves live or cancelled-but-unsettled flights. The timer retains its round-robin owner cursor across upgrades.

## Payment Settlement Reserves and Reconciliation

Before dispatch, Vault reserves 1 MiB of SQLite pages for each ICRC payment. The beneficiary account is allocated when a credit settles. Fixed-size pending records and eight preallocated scan leases allow reconciliation to start and advance at the SQLite page limit. A callback or authoritative reconciliation releases the reserve inside the transaction that writes the receipt and credit. A definitive rejection or recovery of a known-unsent quote also releases it. Unknown transfers keep their reserve. The reserve covers expected SQLite page growth during settlement; canister cycles and stable-memory metadata require separate headroom.

Wiki bridge transfers write their credit and receipt before accepting attached cycles. Indexed beneficiary and bridge budget totals update in the same transaction as admission, reconciliation, and receipt expiry. A full onboarding faucet leaves paid account initialization available.

Unknown payments beyond 23 hours or 100 attempts remain durable and must use manual authoritative ledger/archive reconciliation rather than another transfer. The wallet could have been debited without beneficiary credit; retaining a journal, screenshot, or controller assertion does not recover funds. Do not automatically issue a replacement transfer or manually create compensating credit. Missing or unavailable evidence keeps the payment pending.

Payment rows retain a preparing marker and bounded reconciliation state. Native maximum-width tests cover cursor and lease values and terminal states. Known-unsent preparation can safely retry.

Manual reconciliation reads actual ledger and ledger-nominated archive blocks (up to 100 per update) and never dispatches a transfer. Tuple mismatch, unsupported block types, gaps, and unavailable evidence do not authorize credit. A payment already confirmed by a callback or scan is replayed without another balance change. Same-format upgrades preserve reconciliation state.

## Storage Fee Accounting

Storage fees retain the exact fractional remainder:

```text
numerator   = prior_remainder + bytes * elapsed_ms * 127000
denominator = 1073741824 * 1000
```

The quotient is charged and the remainder survives storage-size changes and compatible upgrades. Old usage settles before its size changes; checkpoints never move backwards. Exhausted balances discard unpaid whole and fractional fees without negative credit or debt. Each owner settles inside a savepoint in the bounded timer sweep; an owner failure preserves its checkpoint and remainder while healthy owners and the existing cursor progress. Database, savepoint, or cursor failures abort the outer transaction and the normal timer retries.

## Schema Migration

Schema 14 validates and migrates the complete schema 13 layout and supported historical layouts in place. Migration installs indexes, removes shared admission guards, and allocates completion reserves for existing unsettled payments. Unsupported or incomplete stores are refused unchanged. See [operations](operations.md) and [validation](validation.md).
