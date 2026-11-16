# Dedicated Vault accounting and capacity

Production funding uses the pinned KINIC ledger and user-requested authoritative reconciliation. Default builds reject foreign ledger configuration before transfer dispatch. Existing journals, holds, balances and valid late callback settlement remain intact. Only an explicitly nondeployable synthetic-funding build permits purchases against synthetic ledgers.

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
| Global settings and billing cursor |        Fixed |          65,536 total |

The maxima total 16,760,832 bytes, leaving 16,384 bytes in the 16 MiB pool. Each string/blob contributes a four-byte length prefix plus raw bytes; each scalar, including nullable integers, contributes eight bytes. Settings have seven 8 KiB slots plus a 512-byte billing cursor inside 64 KiB. Current keys are `config`, `funding`, `generation`, `quote_fee_serial`, `gc-owner` and `serial`; one slot remains. Whole-row and count guards protect the declared bounds.

The authenticated caller owns one prepaid account. Cycle reservations store this owner once; refunds and execution checkpoints settle against the same account even after new work is disabled. Payment wallets and beneficiaries remain separate identities.

Ordinary mutations, including DeleteObject, replay exclusively through `operations`. Its named admission classes are Ordinary, Cleanup, ResourceCleanup and ProtectedKey; one policy controls class counts, result limits and usage charges. `upload_outcomes` separately retains tagged Committed revisions or Cancelled Vault/job pairs under upload IDs and their original begin digest. These lifetimes differ from mutation IDs. Expired pending uploads report Expired until bounded GC produces the same Cancelled outcome as explicit cancellation.

An admitted upload reserves ordinary receipt slots/bytes for each distinct chunk and commit. Pending operations reserve 128 KiB and release unused room when their encoded result is committed. Exact operation retries reuse the same receipt; a fresh-ID duplicate chunk consumes ordinary capacity instead of another upload's reserved completion room. Real-Wasm acceptance completes all three previously unsent chunks and commit while another owner fills every released byte of shared headroom. This is positive-credit completion at full capacity; it does not allow new content or key acquisition without execution credit.

Cleanup of admitted uploads, documents and Vaults uses resource-specific 512-byte completion credits. Resource-backed cleanup receipts are charged to previously admitted resources, separately from the 1,024-row global/512-row owner unreserved cleanup pool. Cancellation preserves its job across batches; each batch removes at most one ciphertext chunk. Purge immediately fences all object history; collection reclaims retired rows in bounded batches. Zero-credit/full-capacity cleanup remains possible. No-work Collect returns NotFound without creating a receipt, and exact retries replay the original result. Receipt retention is 24 hours.

Fresh key acquisition first uses ordinary operation admission. If content capacity or ordinary receipt slots are exhausted, it can use the prepaid emergency key-operation pool: at most 64 retained pending/results globally and 16 per owner, each bounded to 2,048 bytes with at most 1,024 encoded result bytes. Both admission modes share the existing 100/day owner and 1,000/day global key limits, one/eight in-flight bounds, cycle budget and positive-credit requirements. Exact retries retain their stored class, digest and result for the same 24 hours; changed requests conflict. Exhausting the emergency pool refuses new key operations until capacity is reclaimed. This provides bounded fresh access at full content capacity, not unlimited full-capacity reopens.

Each key-flight row carries its 16-byte target Vault alongside the token, phase and generation. Completion and cancellation use that row directly; there is no separate owner setting or derive-control allocation. Protected operation bytes are prepaid globally and still count against owner usage. All owner-only charges are bounded by 512 key flights ×4,096 +16 emergency rows ×2,048 =2,129,920 bytes, below the 16,777,216-byte global pool. Other content, ordinary receipts, upload outcomes, uploads and resource cleanup are counted in both scopes; unreserved cleanup is prepaid in both. Thus valid full global capacity leaves owner quota headroom for bounded key admission without raising or bypassing either quota. Current schema 9 upgrades preserve rows/classes, financial settlement capacity and cleanup reservations.

Key-flight storage is bounded to 4,096 global/512 owner rows. The pool prepays the global row while owner billing conservatively charges 4,096 bytes per row. Bounded GC removes at most 128 settled eligible key rows before fresh admission; live/cancelled-unsettled flights are protected. A full row pool rejects before dispatching a key-service call. Timer collection persists `gc-owner`, advances even for idle owners and wraps fairly; compatible schema 9 upgrades preserve that cursor and all protected work.

Payment admission counts existing accounts plus distinct absent beneficiaries of InFlight/Unknown payments. Multiple pending payments to one beneficiary share a future account slot. Exact retries preserve pinned ledger, sender, recipient, amount, fee, memo and creation time. Credit and final payment status commit atomically. A full payment pool or 16-payment wallet budget blocks new quotes before ledger calls. Positive balances, Unknown payments and unsettled reservations/checkpoints are never evicted to admit new work. Audit evidence may be pruned without removing settlement authority.

Unknown payments beyond 23 hours or 100 attempts remain durable and must use reconciliation rather than another transfer. Use the manual authoritative ledger/archive reconciliation path after those bounds. The wallet could have been debited without beneficiary credit. Retaining a journal, screenshot or controller assertion does not recover funds. Do not automatically issue a replacement transfer or manually create compensating credit. Missing or unavailable evidence keeps the payment pending without creating a replacement transfer.

Schema 9 is the initial release format. Vault has never been deployed. Fresh complete schema 9 and same-format upgrades are supported; unsupported, malformed and foreign stores are refused unchanged. See [operations](vault/operations.md) and [validation](vault/validation.md) for current release boundaries and provenance.

Payment rows retain a preparing marker and bounded reconciliation state. The maximum row is 4,096 bytes, with 1,024 global/16 wallet payment bounds inside the 16 MiB pool. Native maximum-width tests cover cursor/lease values and terminal states. Known-unsent preparation can safely retry.

Manual reconciliation reads actual ledger/ledger-nominated archive blocks, 100 per update, and never dispatches a transfer. Tuple mismatch, unsupported block types, gaps and unavailable evidence do not authorize credit. A payment already confirmed by a callback or scan is replayed without another balance change. Same-format upgrades preserve reconciliation state.

Storage fees retain the exact fraction: `numerator = prior_remainder + bytes * elapsed_ms * 127000`, with denominator `1073741824 * 1000`. The quotient is charged and the remainder survives storage-size changes and compatible upgrades. Old usage settles before its size changes; checkpoints never move backwards. Exhausted balances discard unpaid whole and fractional fees without negative credit or debt. Each owner settles inside a savepoint in the bounded timer sweep; an owner failure preserves its checkpoint and remainder while healthy owners and the existing cursor progress. Database/savepoint/cursor failures abort the outer transaction and the normal timer retries.

Vault IDs come from the existing persistent operation serial. Completed bounded Vault deletion removes the Vault row, so there is no accumulating Vault tombstone or ID-reuse risk. The 3-owner/10,000-global Vault bounds count Pending and Deleting rows. Financial journals and operation receipts retain their independent bounded lifetimes.
