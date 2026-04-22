# VFS Correctness Checklist

This checklist records what the current FS-first contract already covers, what was added in the latest validation pass, and what still remains outside coverage.

## Contract Coverage Matrix

| Contract | Main verification points | Status |
| --- | --- | --- |
| create / update / delete then recreate | `fs_store_basic`, `fs_store_scale`, `vfs_canister` | covered |
| `etag` conflict handling | `fs_store_basic`, `fs_store_vfs`, `vfs_canister` | covered |
| physical delete / removed paths | `fs_store_basic`, `fs_store_sync`, `tests_sync_contract` | covered |
| `append_node` | `fs_store_vfs`, `fs_store_scale`, `vfs_canister` | covered |
| `edit_node` | `fs_store_vfs`, `fs_store_scale`, `vfs_canister` | covered |
| `move_node` / overwrite | `fs_store_vfs`, `fs_store_sync`, `vfs_canister` | covered |
| `list_nodes` shallow / recursive / virtual directory | `fs_store_basic`, `fs_store_scale`, `vfs_canister` | covered |
| deep `glob_nodes("**/*.md")` | `fs_store_vfs`, `fs_store_scale` | covered |
| `recent_nodes` | `fs_store_vfs`, `vfs_canister` | covered |
| `search_nodes` prefix filtering / deleted node suppression | `fs_store_basic`, `fs_store_scale`, `tests_sync_contract` | covered |
| `export_snapshot` stability | `fs_store_basic`, `fs_store_sync`, `vfs_canister` | covered |
| `fetch_updates` empty delta | `fs_store_sync`, `vfs_canister` | covered |
| `fetch_updates` small delta | `fs_store_sync`, `fs_store_scale` | covered |
| `fetch_updates` rename delta | `fs_store_sync` | covered |
| `fetch_updates` removed paths | `fs_store_sync`, `tests_sync_contract` | covered |
| `fetch_updates` prefix scope change | `fs_store_sync`, `tests_sync_contract` | covered |
| mirror tracked-state update | `commands_fs_tests`, `commands_sync_tests` | covered |
| conflict-note generation | `commands_sync_tests` | covered |

## Focus Cases Added In The Current Pass

- `write_node`, `append_node`, and `edit_node` with `1KB`, `4KB`, `16KB`, and `64KB` markdown payloads
- `list_nodes` at `1,000` nodes
- deep `glob_nodes("**/*.md")`
- prefix-limited `search_nodes` with deleted-node suppression
- `fetch_updates` small deltas against large snapshots
- removed paths and prefix-scope changes at the canister boundary
- CLI mirror conflict-note generation and tracked-state updates

## Known Gaps

- wall-clock store-level benchmarks
- long-running large-database growth tests

## Minimum Commands

```bash
cargo test --workspace
bash scripts/build-vfs-canister-canbench.sh
```

If the fixed canbench runtime is available, also run:

```bash
bash scripts/run_canbench_guard.sh
```
