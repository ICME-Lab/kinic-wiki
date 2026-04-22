# VFS Validation Overview

Validation is staged in two layers:

1. prove that the FS-first substrate is correct
2. only then evaluate `llm-wiki` as a knowledge workflow

That split matters because storage, sync, search, and conflict-control failures should not be mixed with higher-level wiki quality evaluation.

## Validation Layers

### Repository checks

Run the existing Rust tests first. They provide the correctness baseline.

### Benchmarks

Use `canbench` and deployed canister benchmarks for API-level workload validation.

The main benchmark targets are:

- `write_node`
- `append_node`
- `edit_node`
- `move_node`
- `delete_node`
- `list_nodes`
- `glob_nodes`
- `search_nodes`
- `export_snapshot`
- `fetch_updates`

## Required VFS Scenarios

### Normal behavior

- create `1KB`, `4KB`, `16KB`, and `64KB` markdown nodes
- append to an existing node
- apply plain-text edits to an existing node
- rename a node and confirm the new path appears while the old path disappears
- delete a node and recreate the same path

### Conflict control

- update succeeds when `etag` matches
- update fails when `etag` mismatches
- delete fails when `etag` mismatches

### Listing and search

- `list_nodes` under `1,000` and `10,000` nodes
- deep `glob_nodes("**/*.md")`
- `search_nodes` with FTS enabled

### Sync

- empty `fetch_updates` delta
- small `fetch_updates` delta
- rename returns the expected `removed_paths + changed_nodes`
- delete keeps `removed_paths` stable

## Acceptance Criteria

### Correctness

- CRUD, move, search, and sync deltas behave consistently
- `etag` conflicts fail as designed
- physical delete followed by same-path recreation remains consistent

### Performance

- `list_nodes`, `search_nodes`, and `fetch_updates` do not collapse as node counts grow
- small changes remain delta-syncable without falling back to full refresh
- single-operation transaction cost stays within an acceptable range

## Next Layer: `llm-wiki`

Once VFS validation is good enough, move on to workflow validation:

- navigation from `index.md`
- source-to-page update flow
- citations near the claims they support
- orphan-page detection
- search as navigation support
- coexistence of human edits and agent edits

## Minimum Execution Set

```bash
cargo test --workspace
bash scripts/build-vfs-canister-canbench.sh
```

If the fixed canbench runtime is available, also run:

```bash
bash scripts/run_canbench_guard.sh
```

See:

- [VFS_CORRECTNESS_CHECKLIST.md](VFS_CORRECTNESS_CHECKLIST.md) for coverage and known gaps
- [VFS_DEPLOYED_CANISTER_BENCHMARKS.md](VFS_DEPLOYED_CANISTER_BENCHMARKS.md) for the deployed benchmark contract
