# Dedicated Vault accounting and capacity

Production funding is compiled-disabled until reviewed authoritative ledger reconciliation exists. Default builds reject quotes and all transfer dispatch, including exact retries, before ledger calls regardless of controller configuration. Existing journals, holds, balances and valid late callback settlement remain intact. Only an explicitly nondeployable synthetic-funding build exercises purchases against a synthetic ledger.

The canister reserves 16 MiB inside its shared 200 MiB logical limit for prepaid accounting. Content, history, uploads, operations and cleanup reservations share the remaining 184 MiB. Owners separately have 200 MiB charged usage, at most 3 Vaults and 100 MiB current plaintext per Vault. Logical accounting excludes SQLite index/page overhead, stable-memory VFS and transient Wasm heap. It is not a physical memory limit or a worst-case memory guarantee. `global_capacity` exposes shared use/reservation/overage; `get_quota` exposes owner/Vault limits. The browser shows these under Account & storage.

The constants and arithmetic are enforced by [capacity.rs](../crates/vault_types/src/capacity.rs):

| Prepaid state                      | Maximum rows | Logical bytes per row |
| ---------------------------------- | -----------: | --------------------: |
| Accounts                           |        1,024 |                   512 |
| Payments                           |        1,024 |                 4,096 |
| Fee lookup leases                  |            8 |                 4,096 |
| Cycle reservations/checkpoints     |       10,000 |                   512 |
| Disposable audit                   |       10,000 |                   512 |
| Key flights                        |        4,096 |                   256 |
| Unreserved cleanup receipts        |        1,024 |                   512 |
| Emergency key operation receipts   |           64 |                 2,048 |
| Current derive controls            |            8 |                   512 |
| Global settings and billing cursor |        Fixed |          65,536 total |

The maxima total 16,764,928 bytes, leaving 12,288 bytes in the 16 MiB pool. Each string/blob contributes a four-byte length prefix plus raw bytes; each scalar, including nullable integers, contributes eight bytes. Settings have seven 8 KiB slots plus a 512-byte billing cursor inside 64 KiB. Current keys are `config`, `funding`, `generation`, `quote_fee_serial`, `gc-owner` and `serial`; one slot remains. Whole-row and count guards protect the declared bounds.

An admitted upload reserves ordinary receipt slots/bytes for each distinct chunk and commit. Pending operations reserve 128 KiB and release unused room when their encoded result is committed. Exact operation retries reuse the same receipt; a fresh-ID duplicate chunk consumes ordinary capacity instead of another upload's reserved completion room. Real-Wasm acceptance completes all three previously unsent chunks and commit while another owner fills every released byte of shared headroom. This is positive-credit completion at full capacity; it does not allow new content or key acquisition without execution credit.

Cleanup of admitted uploads, documents and Vaults uses resource-specific 512-byte completion credits. Resource-backed cleanup receipts are charged to previously admitted resources, separately from the 1,024-row global/512-row owner unreserved cleanup pool. Cancellation preserves its job across batches; each batch removes at most one ciphertext chunk. Purge immediately fences all object history; collection reclaims retired rows in bounded batches. Zero-credit/full-capacity cleanup remains possible. No-work Collect returns NotFound without creating a receipt, and exact retries replay the original result. Receipt retention is 24 hours.

Fresh key acquisition first uses ordinary operation admission. If content capacity or ordinary receipt slots are exhausted, it can use the prepaid emergency key-operation pool: at most 64 retained pending/results globally and 16 per owner, each bounded to 2,048 bytes with at most 1,024 encoded result bytes. Both admission modes share the existing 100/day owner and 1,000/day global key limits, one/eight in-flight bounds, cycle budget and positive-credit requirements. Exact retries retain their stored class, digest and result for the same 24 hours; changed requests conflict. Exhausting the emergency pool refuses new key operations until capacity is reclaimed. This provides bounded fresh access at full content capacity, not unlimited full-capacity reopens.

At most eight transient derive-control settings (512 bytes each) accompany current flights and are removed on matching settlement/cancellation/recovery. Their first allocation does not need content headroom. Protected operation/control bytes are prepaid globally and still count against owner usage. All owner-only charges are bounded by 512 key flights ×4,096 +16 emergency rows ×2,048 +one control ×512 =2,130,432 bytes, below the 16,777,216-byte global pool. Other content, ordinary receipts, uploads and resource cleanup are counted in both scopes; unreserved cleanup is prepaid in both. Thus valid full global capacity leaves owner quota headroom for bounded key admission without raising or bypassing either quota. Existing schema7 rows/classes, financial settlement capacity and cleanup reservations are preserved.

Key-flight storage is bounded to 4,096 global/512 owner rows. The pool prepays the global row while owner billing conservatively charges 4,096 bytes per row. Bounded GC removes at most 128 settled eligible key rows before fresh admission; live/cancelled-unsettled flights are protected. A full row pool rejects before dispatching a key-service call. Timer collection persists `gc-owner`, advances even for idle owners and wraps fairly; compatible schema 7 upgrades preserve that cursor and all protected work.

Synthetic/historical payment admission counts existing accounts plus distinct absent beneficiaries of InFlight/Unknown payments. Multiple pending payments to one beneficiary share a future account slot. Exact retries preserve pinned ledger, sender, recipient, amount, fee, memo and creation time. Credit and final payment status commit atomically. A full payment pool or 16-payment wallet budget blocks new quotes before ledger calls. Positive balances, Unknown payments and unsettled reservations/checkpoints are never evicted to admit new work. Audit evidence may be pruned without removing settlement authority.

Unknown payments beyond 23 hours or 100 attempts remain durable and unresolved. This repository has no authoritative ledger-index reconciliation/finalization path after those bounds. The wallet could have been debited without beneficiary credit. Retaining a journal, screenshot or controller assertion does not recover funds. Do not automatically issue a replacement transfer or manually create compensating credit. Production funding remains blocked pending a separately reviewed reconciliation implementation.

Only fresh complete schema 7 and compatible schema 7 upgrades are supported. Schemas 1–6 and malformed/foreign schemas are refused unchanged. There is no legacy archive import/export or old-schema migration. See [operations](vault/operations.md) and [validation](vault/validation.md) for current release boundaries and provenance.
