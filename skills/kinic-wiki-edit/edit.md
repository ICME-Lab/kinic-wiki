# Kinic Wiki Edit Workflow

## Goal

Apply small, auditable repairs to existing canister-backed wiki nodes without accidental broad rewrites.

## Command Selection

1. Use `read-node --json` or `read-node --fields path,etag,content` to capture current content and etag.
2. Use `edit-node` for one text replacement in one node.
3. Use `multi-edit-node` for multiple text replacements in one node.
4. Use a controlled per-node loop when multiple nodes need edits. `multi-edit-node` is not a multi-node batch command.
5. Use `write-nodes --input <nodes.json>` when replacing full node bodies as a prepared write set.
6. If command flags are not already known, run `<command> --help` before mutation.

## `edit-node`

Use for a single replacement.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --database-id <db> edit-node --path /Wiki/page.md --old-text '<old>' --new-text '<new>' --expected-etag <etag> --json
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
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --database-id <db> multi-edit-node --path /Wiki/page.md --edits-file /tmp/edits.json --expected-etag <etag> --json
```

Semantics:

- edits are applied sequentially to one node
- every `old_text` is replaced globally within that node
- empty `old_text` is invalid
- `expected-etag` protects against concurrent writes

## Multi-Node Repair

1. Build the candidate path list with `search-remote`, `search-path-remote`, `glob-nodes`, or `list-nodes`.
2. Read each candidate and reject false positives before editing.
3. For each accepted node, record `path`, `etag`, match count, and planned command.
4. Apply `edit-node` or `multi-edit-node` one node at a time with `--expected-etag`.
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
