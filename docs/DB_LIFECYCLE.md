# DB Lifecycle

This document describes the operational model for multiple SQLite databases in one VFS canister.

## Identity Model

The database unit is `database_id`.

Principals are attached through `database_members`:

- `owner`: all operations, including grant, revoke, and delete
- `writer`: read and write VFS nodes
- `reader`: read VFS nodes and query/search/list

One database can have multiple principals. One principal can belong to multiple databases.
Public browser reads use the normal member model. Grant anonymous reader access with principal `2vxsx-fae` when a DB should be publicly readable.

## Memory Layout

Stable-memory mount IDs are partitioned by purpose:

- `0..9`: reserved for stable-memory system and SQLite VFS internals
- `10`: index DB
- `11..=32767`: user DB slots
- `32768..=65534`: reserved

The index DB tracks database metadata, membership, and cycles history. User DBs hold VFS node data, search data, and link data.

The index DB startup path ensures the latest schema. Fresh index DBs are created directly at the latest schema, and already-latest DBs are validated only. The only supported automatic migration is the production mainnet `database_index:011_source_run_sessions` to latest upgrade. Partial billing schemas, index DBs without `schema_migrations`, and pre-011 schemas are rejected instead of repaired.

Pending DBs have index metadata and cycle accounts but no stable-memory mount ID. Active DBs consume one active user DB slot. A pending DB consumes a mount ID only after the first successful cycle purchase activates it.

## Status

Databases move through three statuses:

- `pending`: metadata reserved, no mounted SQLite DB yet, only cycle purchase and owner management are available
- `active`: mounted and usable for VFS read/write/search/list
- `deleted`: hard-deleted from public database lists and normal DB operations

Only `active` DBs are available to normal VFS APIs.

## Size Tracking

`logical_size_bytes` is the billable SQLite bytes for an active database.

It is updated after VFS mutations and storage billing settle. SQLite free pages are included. Index DB bytes, canister heap, and shared management state are excluded.

Deleting a DB releases the active mount. It does not imply that canister stable memory shrinks or that the stable-memory mount ID is reused.

## Cycles

KINIC cycles uses one internal DB-scoped balance:

- DB cycles balance: KINIC pulled from the external ledger directly into a reserved DB

DB creation uses `create_database(CreateDatabaseRequest { name })`. It creates a generated `database_id`, owner membership, and a zero DB cycles balance without allocating a stable-memory mount ID. The DB remains `pending` and cycles-suspended until its first successful cycle purchase activates the mounted SQLite DB.

External ledger calls are used for DB cycles purchase and App KINIC balance movement:

- `purchase_database_cycles(DatabaseCyclesPurchaseRequest)` pulls the KINIC payment from the caller through ICRC-2 `approve` + `icrc2_transfer_from` and mints cycles into that DB cycles balance. The request includes `payment_amount_e8s` and `min_expected_cycles`; credited cycles are computed from the current `cycles_per_kinic` before the ledger call and must be at least `min_expected_cycles`. The approved allowance must cover `payment_amount_e8s + ledger_fee_e8s`.
- `kinic_deposit_balance(KinicDepositRequest)` credits App KINIC only after the canister pulls KINIC through ICRC-2 `approve` + `icrc2_transfer_from`.
- `kinic_withdraw_balance(KinicWithdrawRequest)` sends KINIC from the canister to the requested ledger account with ICRC-1 `icrc1_transfer`. App balance is debited by `amount_e8s + expected_fee_e8s`. Direct ledger transfers to a principal are not credited to App KINIC balance.

Any authenticated caller can cycle purchase an existing DB that still has an owner, including callers with no DB role. The payer is recorded in the DB ledger entry. Reader and writer cycles history redacts payer/caller principals, while DB owner and billing authority can read full payer/caller details. Once the ledger call starts, normal completion or explicit ledger-error cancellation resolves the started operation even if membership changes during the await. Ambiguous ledger results keep the pending operation as `ambiguous` for billing-authority review. If ledger transfer succeeds but local activation or cycles apply fails, the completed pending operation remains for billing-authority review. Owner, billing authority, and payer can inspect pending purchase status through `list_database_cycles_pending_purchases(database_id)` or CLI `database cycles-pending <database-id>`.

Successful DB update calls are charged after execution. The charge is raw cycle usage:

```text
cycles_delta
```

Cycles are stored as raw integer cycles. The default purchase rate is `1 KINIC = 234_500_000_000 cycles` (`0.2345 Tcycle`), controlled by `cycles_per_kinic`. Before a metered update, the caller role is checked first, then the DB cycles balance must be at least `min_update_cycles` and the DB must not be suspended. Non-members receive access errors without learning cycles state. Metered updates include content mutations and `grant_database_access`; successful grant calls record `method = "grant_database_access"` in the charge ledger. The IC 13-node execution fee model is `5_000_000 cycles + 1 cycle per executed Wasm instruction`, but metered DB billing charges `20_000_000 cycles + 1 cycle per measured instruction`. The extra `15_000_000` cycles covers local-canister-measured internal accounting overhead from the post-update `charge_database_update` index DB writes. Measurement uses the current message instruction counter delta, not same-message canister balance deltas. If the IC fee table, target subnet type, or accounting overhead changes, update `UPDATE_EXECUTION_BASE_CYCLES`, `UPDATE_ACCOUNTING_OVERHEAD_CYCLES`, and this billing documentation together. If the post-update charge exceeds the DB cycles balance, the remaining DB cycles are fully charged, the balance becomes `0`, and the DB is suspended.

Storage billing settles every 24h from a canister timer, with controller-only `settle_database_storage_charges_batch(request)` as recovery path. Only mounted DBs with `status = active` are charged. The batch cursor is an exclusive `mount_id` cursor: pass `cursor_mount_id` to resume after that mount, and pass `limit` as `1..=1000`; omitted `limit` defaults to `100`. The 13-node subnet rate is fixed at `127_000 cycles / GiB / sec`:

```text
storage_cycles = logical_size_bytes * elapsed_seconds * 127_000 / 2^30
```

Storage charges use the latest `logical_size_bytes` stored in the index DB and write `kind = "storage_charge"` ledger entries for actually collected cycles. Settlement does not open every DB to remeasure size; write/update paths keep `logical_size_bytes` current enough for billing. Insufficient-balance unpaid cycles are not carried forward or tracked as debt in v1. The residual cost above the remaining balance is forgiven as subsidy/suspension policy, the remaining balance is consumed, and the DB is suspended. Timer settlement persists `cursor_mount_id` and a fixed `billing_now_ms` in the index DB, processes up to six 1000-DB batches per message, and schedules a short continuation timer while `next_cursor_mount_id` remains. The same `billing_now_ms` is reused until the run finishes, so DBs in one run do not receive different elapsed times. Settlement execution overhead allocation and index DB byte billing are outside this flow.

`database_cycle_ledger` is the cycles source of truth. Successful charged update calls are recorded there directly. Ledger-backed cycle purchase entries store ledger block indexes in `ledger_block_index`.

Cycles history redacts payer/caller principals for reader and writer callers. DB owner and billing authority can read full cycles history. Pending cycle purchase status is visible only to owner, billing authority, and the payer of that operation. New cycles history fields must not carry payer/caller principals unless the same redaction policy is applied.

`kinic_ledger_canister_id` and `billing_authority_id` are fixed at init. The billing authority may update only rate and minimum-balance fields by calling `update_cycles_billing_config` with a `CyclesBillingConfigUpdate` record.

`scripts/local/deploy_wiki.sh` carries local development init args. If `BILLING_AUTHORITY_ID` is unset, local deploy uses `icp identity principal`. The deploy script does not create a ledger canister by itself. Use `scripts/local/setup_kinic_ledger.sh` for a project-local ICRC ledger.

Unit tests do not deploy a ledger. They mock ledger transfer outcomes inside the canister test harness. Production deploy must use `scripts/mainnet/deploy_wiki.sh` with explicit `KINIC_LEDGER_CANISTER_ID` and `BILLING_AUTHORITY_ID`. The script rejects unset, empty, or anonymous values before install. These principal values cannot be changed after init.

Upgrade compatibility:

- `post_upgrade` accepts no arg, a bare `CyclesBillingConfig`, or `opt CyclesBillingConfig`.
- The first upgrade from the pre-billing mainnet index schema requires a valid `CyclesBillingConfig`; missing or invalid principals trap before migration.
- After `cycles_billing_config` exists in the index schema, no-arg upgrade is supported and the stored config remains authoritative.
- The only supported automatic billing upgrade is the production pre-billing mainnet `database_index:011_source_run_sessions` schema to latest. Partial billing schemas and legacy credit schemas are unsupported; recreate or reinstall those DBs instead of auto-converting them.

Normal operator flow:

1. Owner creates a pending DB with `create_database(CreateDatabaseRequest { name })`.
2. Payer approves the VFS canister on the KINIC ICRC-2 ledger for the payment amount plus ledger transfer fee. Browser approve uses the current allowance as `expected_allowance` and expires after 30 minutes. The approve transaction fee is paid separately by the wallet.
3. Payer calls `purchase_database_cycles` with the payment amount. If the DB is pending, the canister starts the ledger transfer first, then allocates and migrates the DB mount only after the ledger transfer succeeds. The DB becomes active when mount migration and balance cycle both complete.
4. Successful DB updates consume DB cycles balance.
5. DB delete discards any remaining cycles.

source capture and query-answer sessions can expire after issuance if the DB becomes suspended or drops below the minimum update balance. Browser write UI also treats suspended, low-balance, or cycles-config-unavailable DBs as not writable. Browser and worker paths re-check cycles before forwarding to external Worker or DeepSeek calls. source capture source generation carries the original `sessionNonce` through the queue and re-checks the session immediately before DeepSeek.

Treasury sweep, DB-specific ledger subaccounts, repair browser UI, purchase retry API, and ambiguous purchase repair/cancel API are not implemented.

DB cycle purchase credits internal cycles only after `icrc2_transfer_from` returns `Ok(block_index)` and local activation/apply both finish. Explicit ledger errors cancel the `in_flight` operation without credit. Ambiguous inter-canister call or response decoding stores `operation_status = "ambiguous"` without credit and returns an error containing the `operation_id`. If ledger transfer succeeds but local DB activation or cycle application fails, the canister stores `operation_status = "completed"` with the ledger block index, does not credit cycles, and returns a local apply error containing the `operation_id` and ledger block index.

Pending cycle operations are temporary state for transfer-in-flight, ambiguous ledger result review, ledger-success-before-local-apply review, memo correlation, and duplicate purchase guard. Owner, billing authority, and the payer of each operation can inspect them through `list_database_cycles_pending_purchases(database_id)` or CLI `database cycles-pending <database-id>`. The public status exposes `operation_id`, `database_id`, `status`, `amount_cycles`, `payment_amount_e8s`, `ledger_block_index`, `created_at_ms`, and `required_action`; unrelated callers are rejected.

## Delete

`delete_database(DeleteDatabaseRequest)` is owner-only.

Delete is a hard delete:

- the SQLite DB file is removed where file deletion is available
- DB membership, cycles, pending operations, and transient sessions are removed from the index
- `database_mount_history` is retained so the stable-memory mount ID is not reused by another DB in v1
- the stable-memory mount ID is not reused by another DB in v1

Delete requires no pending cycle purchase operations. The request carries only `database_id`. Remaining DB cycles are discarded with the deleted index rows.

Delete is treated as irreversible.
Deleted DBs are absent from `list_databases` and subsequent DB operations return `database not found`.

## Snapshot Sync Retry

Paged snapshot sync uses `snapshot_revision` plus cursor instead of canister-side snapshot sessions.
If a DB changes during a multi-page snapshot, later pages can fail with `snapshot_revision is no longer current`.
Busy DBs may require caller retry by restarting the snapshot export flow.

## Current Limits

- At most 32757 lifetime user DB slots per canister: mount IDs `11..=32767`.

## Follow-ups

- Caffeine or external object storage integration is out of scope for v1.
