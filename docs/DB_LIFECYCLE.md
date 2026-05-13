# DB Lifecycle

This document describes the operational model for multiple SQLite databases in one VFS canister.

## Identity Model

The database unit is `database_id`.

Principals are attached through `database_members`:

- `owner`: all operations, including grant, revoke, delete, archive, and restore
- `writer`: read and write VFS nodes
- `reader`: read VFS nodes and query/search/list

One database can have multiple principals. One principal can belong to multiple databases.
Public browser reads use the normal member model. Grant anonymous reader access with principal `2vxsx-fae` when a DB should be publicly readable.

## Memory Layout

Stable-memory mount IDs are partitioned by purpose:

- `0..9`: WASI filesystem memory for tmp files and directory metadata
- `10`: index DB
- `11..=32767`: user DB slots
- `32768..=65534`: reserved

The index DB tracks database metadata and membership. User DBs hold VFS node data, search data, and link data.
The index DB also stores an internal `usage_events` ledger for update calls.

The billing index schema is a breaking initial schema. Existing index DBs with an older `schema_migrations` value are rejected with `fresh index required`; operators must install against a fresh index instead of relying on automatic migration.

Hot, archiving, or restoring DBs consume one active user DB slot. Archived and deleted DBs release their active mount, but v1 does not recycle stable-memory mount IDs for another database.

## Status

Databases move through five statuses:

- `hot`: mounted and usable for VFS read/write/search/list
- `archiving`: mounted for chunk export, VFS operations rejected until finalize succeeds
- `archived`: not mounted, active mount released, snapshot metadata retained
- `deleted`: not mounted, active mount released, not restorable unless an external archive was taken first
- `restoring`: mounted for chunk import, VFS operations rejected until finalize succeeds

Only `hot` DBs are available to normal VFS APIs.

## Size Tracking

`logical_size_bytes` tracks the SQLite file size for a database.

It is updated after VFS mutations and restore finalization. It is useful for visibility and planning, but it is not a stable-memory billing or shrink metric.

Deleting or archiving a DB releases the active mount. It does not imply that canister stable memory shrinks or that the stable-memory mount ID is reused.

## Usage Ledger

`usage_events` records update calls only. Query calls are not recorded.

Each event stores method, database ID when present, caller principal, success flag, observed cycle delta, error text, and timestamp.
The cycle delta is an operational observation from canister balance before and after the update, not a guaranteed one-to-one IC billing statement.
Only the latest 100,000 events are retained. The ledger is internal operational material, not a guaranteed billing statement.

## Billing

KINIC billing uses two internal balances:

- principal balance: KINIC pulled from the external ledger by `top_up_principal_balance`
- database balance: KINIC allocated from a principal balance to a DB

DB creation requires `create_database(display_name, initial_deposit_e8s)`. The initial deposit is debited from the caller principal balance and credited to the new DB balance. The default minimum initial deposit is `1_000_000` e8s.

External ledger calls are limited to principal top-up and principal withdraw:

- `top_up_principal_balance(amount_e8s)` pulls from the caller through ICRC-2 `approve` + `icrc2_transfer_from`
- `withdraw_principal_balance(amount_e8s, to)` sends through ICRC-1 `icrc1_transfer`

Principal-to-DB allocation and DB-to-owner withdraw are internal ledger movements. DB withdraw credits the owner principal balance; it does not call the external ledger.

Successful DB update calls are charged after execution. The charge is:

```text
ceil(cycles_delta * rate_numerator_e8s / rate_denominator_cycles) + fixed_update_fee_e8s
```

The default rate is `200 / 1_000_000` cycles and the default fixed update fee is `100` e8s. Before a metered update, the DB balance must be at least `min_update_balance_e8s` and the DB must not be suspended. If the post-update charge exceeds the DB balance, the remaining balance is fully consumed, the DB is suspended, and the update result remains successful.

`database_billing_ledger` and `principal_billing_ledger` are the billing source of truth. `usage_events` remains an operational log only.

`kinic_ledger_canister_id` and `sns_governance_id` are fixed at init. SNS governance may update only rate and minimum-balance fields by calling `update_billing_config` with a Candid-encoded `BillingConfigUpdate` blob. `validate_update_billing_config` performs the same validation without changing state.

`icp.yaml` carries local development init args with anonymous placeholder principals. Production deploy must use `scripts/mainnet/deploy_wiki.sh` with `KINIC_LEDGER_CANISTER_ID` and `SNS_GOVERNANCE_ID`; the script rejects unset, empty, or anonymous values before install. These principal values cannot be changed after init.

Normal operator flow:

1. User approves the VFS canister on the KINIC ICRC-2 ledger.
2. User calls `top_up_principal_balance(amount_e8s)`.
3. User creates a DB with `create_database(display_name, initial_deposit_e8s)` or allocates existing principal balance with `top_up_database`.
4. Successful DB updates consume DB balance.
5. Owner can move DB balance back to principal balance with `withdraw_database_balance`.
6. User can withdraw principal balance to an external KINIC account with `withdraw_principal_balance`.

If principal withdraw receives an explicit ledger error, the debit is reversed. If the inter-canister call or response decoding is ambiguous, the debit remains pending and the principal ledger records `withdraw_ambiguous`; initial repair is manual.

## Delete

`delete_database` is owner-only.

Delete is a soft delete in the index:

- status becomes `deleted`
- active mount ID is cleared
- logical size is set to `0`
- the stable-memory mount ID is not reused by another DB in v1

Delete is treated as irreversible. If recovery is required, archive first and store the exported bytes outside the canister.
Deleted DBs remain listed for billing visibility. DB top-up is rejected after delete, but owner-only DB balance withdraw remains available.

## Archive

Archive is a low-level snapshot byte export flow:

1. `begin_database_archive(database_id)` moves the DB to `archiving`, updates `updated_at_ms`, and returns the current DB file size.
2. `read_database_archive_chunk(database_id, offset, max_bytes)` exports file bytes by range.
3. Caller stores the bytes outside the canister.
4. `finalize_database_archive(database_id, snapshot_hash)` verifies the SHA-256 digest, marks the DB archived, and releases the active mount.

The canister does not persist archive bytes. The caller owns external storage and retry behavior.

`snapshot_hash` must be the 32-byte SHA-256 digest of the exported SQLite bytes.
If hash verification fails, the DB stays `archiving`; the caller can reread bytes and retry finalize or call `cancel_database_archive(database_id)` to return the DB to `hot`.
`cancel_database_archive` is owner-only and only valid while the DB is `archiving`.
Archive reads reject chunks larger than 1 MiB.
Finalize computes the digest by reading the whole SQLite file in one update. Large DBs can increase instruction and cycle cost; a future archive flow can move this to incremental chunk hashing.

## Restore

Restore is a low-level snapshot byte import flow:

1. `begin_database_restore(database_id, snapshot_hash, size_bytes)` moves an archived or deleted DB to `restoring` and allocates a new slot.
2. `write_database_restore_chunk(database_id, offset, bytes)` writes imported bytes.
3. `finalize_database_restore(database_id)` checks file size and SHA-256 digest, runs DB migrations, and returns the DB to `hot`.

Restore can only begin from `archived` or `deleted`. It cannot begin from `hot` or while already `restoring`.
If the canister cannot mount the newly allocated DB file during begin, the DB rolls back to its previous `archived` or `deleted` state. The failed mount ID remains in mount history and is not reused.

If finalize fails because the file size is wrong, the DB stays `restoring`. The caller can write missing bytes and retry finalize.
Restore rejects chunks larger than 1 MiB and declared DB sizes larger than `i64::MAX`.
Restore finalize also hashes the whole restored SQLite file in one update, so large imports have the same instruction and cycle-cost concern as archive finalize.

## Snapshot Sync Retry

Paged snapshot sync uses `snapshot_revision` plus cursor instead of canister-side snapshot sessions.
If a DB changes during a multi-page snapshot, later pages can fail with `snapshot_revision is no longer current`.
Busy DBs may require caller retry by restarting the snapshot export flow.

## Current Limits

- At most 32757 lifetime user DB slots per canister: mount IDs `11..=32767`.
- Archive export and restore import chunks are limited to 1 MiB.
- Declared restore DB size must fit the runtime database size limit, currently `i64::MAX`.
- v1 does not treat archived or deleted slots as reusable concurrent capacity.

## Follow-ups

- `delete_database` currently deletes the SQLite file before marking the DB `deleted`. A later lifecycle change should add a `deleting` state or equivalent two-phase flow before reordering this safely.
- Archive/restore APIs are canister-level primitives. The CLI does not yet provide archive export/import commands.
- Caffeine or external object storage integration is out of scope for v1.
