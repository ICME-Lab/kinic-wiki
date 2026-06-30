# Kinic Wiki Edit Workflow

## Goal

Apply small, auditable repairs to existing canister-backed knowledge nodes without accidental broad rewrites.

## Command Selection

1. Use `list-nodes`, search preview, or `query-sql` to build and narrow candidate path sets before full reads.
2. Use `read-node --json` or `read-node --fields path,etag,content` immediately before mutation to capture current content and etag.
3. Use `edit-node` for one text replacement in one node.
4. Use `multi-edit-node` for multiple text replacements in one node.
5. Use a controlled per-node loop when multiple nodes need edits. `multi-edit-node` is not a multi-node batch command.
6. Use `write-nodes --input <nodes.json>` when replacing full node bodies as a prepared write set.
7. If command flags are not already known, run `<command> --help` before mutation.

## Read Strategy

1. Use `list-nodes --prefix <path> --recursive --json` for path inventory and etag-only triage.
2. Use `search-remote` or `search-path-remote` with `--preview-mode content-start` to identify likely matches before full reads.
3. Use `query-sql` for known-path multi-node reads from `fs_nodes` when checking false positives or preparing full-body replacements.
4. Use `export_snapshot` only through Store API/tool access when a repair needs a whole scope. It is not a normal CLI command.
5. Use `fetch_updates` only through Store API/tool access when a trusted `snapshot_revision` already exists.
6. Always re-read each accepted node with `read-node --json` or `read-node --fields path,kind,etag,content` immediately before mutation.

## `edit-node`

Use for a single replacement.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --database-id <db> edit-node --path /Knowledge/page.md --old-text '<old>' --new-text '<new>' --expected-etag <etag> --json
```

Add `--replace-all` only after confirming every match in that node should change.

## `multi-edit-node`

Use for several replacements in the same node.

```json
[
  { "old_text": "old phrase", "new_text": "new phrase" },
  { "old_text": "remove this", "new_text": "" }
]
```

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --database-id <db> multi-edit-node --path /Knowledge/page.md --edits-file /tmp/edits.json --expected-etag <etag> --json
```

Semantics:

- edits are applied sequentially to one node
- every `old_text` is replaced globally within that node
- empty `old_text` is invalid
- `expected-etag` protects against concurrent writes

## Multi-Node Repair

1. Build the candidate path list with `search-remote`, `search-path-remote`, `glob-nodes`, or `list-nodes`.
2. Use search `--preview-mode content-start` and `query-sql` to reject false positives before editing.
3. For each accepted node, record `path`, `etag`, match count, and planned command.
4. Re-read each accepted node immediately before mutation, then apply `edit-node` or `multi-edit-node` one node at a time with `--expected-etag`.
5. Stop on etag mismatch or unexpected replacement count. Re-read the node before retrying.
6. Verify with a narrow `search-remote` over the affected prefix and representative `read-node`.
7. Append one compact `log.md` line covering the repair batch and affected path count.

For leakage cleanup, prefer per-node etag writes over an unknown batch path. Speed is secondary to avoiding over-redaction.

## Output

Report:

- paths edited
- command family used: `edit-node`, `multi-edit-node`, or `write-nodes`
- verification performed
- skipped false positives or etag conflicts
