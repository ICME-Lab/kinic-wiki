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
- filesystem v003 Git-history backfill during upgrade

The migration suite uses synthetic content only. `git_v003_backfill_representative` models one database with 100 nodes, about 1 MiB total content, a 128 KiB maximum node, and path depth 5. `git_v003_backfill_stress` models ten databases with 100 nodes each, 2 MiB per database, a 1.5 MiB maximum node, and path depth 8. Fixture creation and DDL are outside the named benchmark scope; the measured body runs the production history/blob/index/tree/initial-commit backfill synchronously in one update message.

Results recorded on 2026-08-14 with canbench 0.4.1 and PocketIC 10.0.0:

| Case | Instructions | Heap increase | Total heap after fixture + backfill | Stable-memory high-water increase | Total stable memory |
| --- | ---: | ---: | ---: | ---: | ---: |
| representative | 301.00 M | 35 pages | 200 pages (12.50 MiB) | 0 pages | 390 pages (24.38 MiB) |
| stress | 3.96 B | 710 pages | 1,351 pages (84.44 MiB) | 0 pages | 1,542 pages (96.38 MiB) |

The zero high-water increase means the backfill reused stable-memory pages already allocated while preparing the synthetic legacy content; it does not mean that history has no logical storage cost. The stress result uses 1.32% of the current 300 B install/upgrade instruction limit, 2.06% of the 4 GiB wasm32 heap limit, and 0.02% of the 500 GiB stable-memory capacity, leaving more than 30% headroom against each platform ceiling. These limits come from the [ICP execution error reference](https://docs.internetcomputer.org/references/execution-errors/) and [canister memory model](https://docs.internetcomputer.org/concepts/canisters/). The release operator must still inspect the target canister's configured `wasm_memory_limit`; this repository does not set one, and a lower live setting overrides the platform heap ceiling.

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
- both Git-history migration cases complete with measured instruction, Wasm heap, and stable-memory usage recorded
- release evidence identifies the target environment limits and retains at least 30% headroom for each migration resource; otherwise rollout stops for migration redesign

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
