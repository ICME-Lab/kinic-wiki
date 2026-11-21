# Intermediate source retention

`archive_intermediate_source` is a controller-only maintenance update. It removes
one explicitly reviewed raw PostToolUse learning source and its sole revision
from the existing SQLite image. Ordinary `delete_node` retains full history and
is unsuitable for this operation. This does not shrink stable memory.

Before invoking it, retain and verify a backup of the current source and its
complete history. Inspect current Wiki bodies/metadata, directory references,
local outbox, jobs and pending inputs for dependencies. Bind that inspection to
the root `export_snapshot` revision; keep the destination delivery lease while
revalidating. Only an explicitly accepted path list may be processed. The
`backup_manifest_sha256` identifies the operator's verified backup manifest;
the canister cannot independently verify possession of that external backup.

The request also binds the database mount, current etag, node identity, sole
revision number and original content hash. Reject changed snapshots rather than
refreshing the guard without reinspection. The canister refuses terminal or
protected records, incoming links, published nodes, pending publication recovery,
retained learning-publication references, shared evidence and multi-version
history. Work is capped at one 1 MB raw source. Publication receipts are indexed
by node ID in batches of up to 16 receipts, with a 4 MB batch budget that permits
one larger receipt to be indexed on its own. When the call returns
`indexing publication references; retry archive to continue`, it has saved
index progress and has removed no node. Retry the same guarded request while
the snapshot is unchanged. Every call checks for newly appended receipts
before using the index. Logical rebuilds copy the original receipts and derive
the index again on demand.

Deletion, FTS/link removal, sync removal and revision pruning share one SQLite
transaction. Tombstone identity and delta-sync records remain. No schema
migration, new mount, VACUUM, global history purge or source-folder deletion is
performed. The result reports page counts before and after, plus the new root
revision. An uncertain response must be reconciled using current-node/history
queries; do not substitute another target or retry with fresh guards blindly.

`database_storage_stats` is also controller-only. Reusable space is
`freelist_pages * page_size`. Report it separately from `page_count * page_size`
and allocated stable memory. FTS and other retained structures mean body lengths
are not physical reclamation estimates.

The production maintenance artifact must be built on the verified deployed
source revision with only this retention patch. Keep the ordinary feature build
separate. Before deployment, preserve a fresh recovery checkpoint, verify the
exact deployed Wasm, and run the PocketIC upgrade/reuse/rollback test with that
Wasm as baseline. Do not restore a whole-canister snapshot automatically: doing
so would roll back unrelated writes across databases. Software rollback and
restoring archived data are separate recovery operations.
