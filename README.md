# llm-wiki

The best agents already think in files.  
`llm-wiki` gives them a persistent VFS backed by an IC canister and SQLite, while humans keep working in Obsidian.

The source of truth is remote `/Wiki/...` nodes.  
The local working copy is your vault's `Wiki/` folder.

## Why filesystems?

Agents already reason well about:

- reading a file
- appending to a log
- editing part of a document
- listing folders
- globbing paths
- searching memory
- moving notes when structure changes

This project keeps that file-oriented mental model, but replaces ad hoc local files with:

- a canister-backed remote store
- explicit sync
- SQLite full-text search
- `etag`-based conflict control
- an Obsidian working copy for humans

## What you get

- persistent FS-first memory on the canister
- local `Wiki/` mirror in Obsidian
- built-in search and sync
- ready-made tool schemas for OpenAI-compatible and Anthropic-compatible tool calling
- CLI commands for direct path-based operations

Current scope:

- single-tenant
- text-first
- `/Wiki/...` as the single public root

## CI and Benchmarks

This repo is expected to stay green on:

- `cargo fmt --all -- --check`
- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cd plugins/kinic-wiki && npm run check`

There is also a dedicated canister build path and an optional `canbench` workflow:

- production-style canister build: `bash scripts/build-wiki-canister.sh`
- benchmark build config: `canbench.yml`
- benchmark build script: `bash scripts/build-wiki-canister-canbench.sh`
- benchmark runner: `bash scripts/run_canbench_guard.sh`
- scale benchmark runner: `bash scripts/run_canbench_scale.sh`

`canbench` uses a fixed PocketIC runtime requirement:

- `canbench 0.4.1` expects `pocket-ic-server 10.0.0`
- `pocket-ic-server 11.x` and `12.x` are not accepted
- the runner prefers `./.canbench/pocket-ic` when present, then falls back to `POCKET_IC_BIN`
- CI provisions `./.canbench-tools/bin/canbench` and `./.canbench/pocket-ic` via `bash scripts/setup_canbench_ci.sh`
- the repo ignores `./.canbench/` and `./.canbench-tools/`, so local runtime and local canbench binaries stay untracked

## VFS Validation

The repo keeps VFS validation inside the workspace first.

- correctness checklist: [`VFS_CORRECTNESS_CHECKLIST.md`](VFS_CORRECTNESS_CHECKLIST.md)
- staged validation plan: [`VFS_VALIDATION_PLAN.md`](VFS_VALIDATION_PLAN.md)
- external benchmark guide: [`VFS_EXTERNAL_BENCHMARKS.md`](VFS_EXTERNAL_BENCHMARKS.md)
- deployed canister benchmark guide: [`VFS_DEPLOYED_CANISTER_BENCHMARKS.md`](VFS_DEPLOYED_CANISTER_BENCHMARKS.md)

Minimum validation commands:

- `cargo test --workspace`
- `cd plugins/kinic-wiki && npm run check`
- `bash scripts/build-wiki-canister-canbench.sh`

If your environment has the fixed canbench runtime, also run:

- `bash scripts/run_canbench_guard.sh`

`bash scripts/bench/run_all_vfs_benchmarks.sh` also tries the guard, but skips it when the runtime is missing or the PocketIC version does not match `pocket-ic-server 10.0.0`.

The canbench coverage is centered on these VFS operations:

- `write_node`
- `append_node`
- `move_node`
- `search_nodes`
- `export_snapshot`
- `fetch_updates`

The scale runner writes review artifacts to `artifacts/canbench/`:

- `scale_results.json`
- `scale_results.csv`
- `scale_report.md`

Use `CANBENCH_REPEATS=1 bash scripts/run_canbench_scale.sh` for a single smoke run; the default is 3 repeats for min/max/stddev. Compare two generated JSON files with `python3 -m scripts.canbench.compare --baseline <old>/scale_results.json --candidate <new>/scale_results.json --output-dir artifacts/canbench/compare`.

It executes `N = 1000, 10000, 50000` for:

- `write`
- `append`
- `move`
- `search`
- `export_snapshot`
- `fetch_updates`

The validation split is:

- external filesystem-style benchmarks: `fio`, `smallfile`, `SQLite`
- deployed canister benchmarks: `run_canister_vfs_workload.sh`, `run_canister_vfs_latency.sh`
- VFS-native scaling benchmarks: `canbench` for `write`, `append`, `move`, `search`, `export_snapshot`, `fetch_updates`
- memory-quality benchmark harness: `wiki-cli beam-bench` for BEAM-style retrieval evaluation over imported wiki notes

## BEAM Benchmark Harness

`wiki-cli beam-bench` is separate from `canbench`.

- `canbench` measures canister-side API scale and instructions
- `beam-bench` measures retrieval quality after importing long conversations into `/Wiki/beam/...`

The BEAM harness currently targets two providers:

- `codex` provider: Codex CLI e2e over `wiki-cli` read-only commands
- `openai` provider: OpenAI Responses API via `OPENAI_API_KEY`
- read-only tool/command access only
- artifacts: `summary.json`, `results.jsonl`, `failures.jsonl`, `report.md`

Example:

```bash
cargo run -p wiki-cli -- \
  --replica-host http://127.0.0.1:4943 \
  --canister-id aaaaa-aa \
  beam-bench \
  --dataset-path fixtures/beam/beam_sample.json \
  --split 100K \
  --model gpt-4.1 \
  --output-dir artifacts/beam-sample \
  --provider codex \
  --codex-sandbox danger-full-access \
  --limit 1 \
  --questions-per-conversation 1 \
  --parallelism 1
```

The harness imports each conversation under a namespaced prefix such as `/Wiki/beam/beam-run-<timestamp>/<conversation_id>/` and keeps probing answers out of the wiki notes. The `codex` provider defaults to `danger-full-access` so the child Codex process can reach the local PocketIC gateway. This command is intended for manual or dedicated benchmark runs rather than normal CI.

Optional external VFS benchmarks:

- `bash scripts/bench/run_fio_vfs.sh`
- `bash scripts/bench/run_smallfile_vfs.sh`
- `bash scripts/bench/run_sqlite_speedtest1.sh`
- `bash scripts/bench/run_sqlite_commit_latency_vfs.sh`
- `bash scripts/bench/run_all_vfs_benchmarks.sh`

The external benchmark artifacts are written to `.benchmarks/results/<tool>/<timestamp>/` and always include:

- `summary.txt` for the human-facing summary
- `config.json` for the true benchmark settings
- `environment.json` for the execution environment
- `raw/*.json` or tool-native raw output for the source data

Within SQLite benchmarks, `speedtest1` is a broad reference workload and `commit latency` is the primary durability-sensitive benchmark. Snapshot/export/update scaling remains a `canbench` concern rather than an external filesystem benchmark concern.

Optional deployed canister benchmarks:

- `REPLICA_HOST=http://127.0.0.1:4943 CANISTER_ID=<id> bash scripts/bench/run_canister_vfs_workload.sh`
- `REPLICA_HOST=http://127.0.0.1:4943 CANISTER_ID=<id> bash scripts/bench/run_canister_vfs_latency.sh`

These runs target an already deployed canister through `ic-agent`. They are not host filesystem benchmarks and they are not `canbench`.

The deployed benchmark artifacts are written to `.benchmarks/results/<tool>/<timestamp>/` and always include:

- `summary.txt` for the human-facing summary
- `config.txt` for the true benchmark settings as JSON text
- `environment.txt` for the execution environment plus `replica_host`, `canister_id`, `bench_transport`, `canister_status_source`
- `raw/*.txt` for scenario-level aggregated source data as JSON text

The deployed canister benchmark split is:

- `run_canister_vfs_workload.sh`: API-centric repeated request benchmarks over `create`, `update`, `append`, `edit`, `move`, `delete`, `read`, `list`, `search`
- `run_canister_vfs_latency.sh`: single-update mutation latency over `write_node` and `append_node`

The deployed canister benchmark focus is:

- primary metrics: `cycles + latency + wire IO`
- payload sizes: `1k`, `10k`, `100k`, `1MB`
- cycles source: `icp canister status --json`
- update-heavy scenarios default to `isolated_single_op`
- query and fallback scenarios keep `scenario_total`
- update response contract: `write / append / edit / move / delete / multi_edit` return a lightweight ACK, not full node content

Interpretation notes:

- `isolated_single_op` writes seed data only in setup and measures only the pure API calls in the measure phase
- `isolated_single_op` saves `setup_cycles_delta` plus `measured_cycles_delta`
- `cycles_per_measured_request` is the primary cost field for isolated update scenarios
- `scenario_total` remains as a compatibility metric for query-style scenarios and legacy comparisons
- `WIKI_CANISTER_DIAGNOSTIC_PROFILE=fts_disabled_for_bench` excludes `search` from the default workload matrix because FTS maintenance is intentionally disabled and the resulting search behavior is not comparable to baseline

Validation boundary for the current benchmark changes:

- benchmark success is currently checked with `cargo test -p wiki-cli --bin vfs_bench`
- the Codex schema-path guard is checked with `cargo test -p wiki-cli beam_bench::model::tests::codex_schema_paths_are_unique`
- `cargo test -p wiki-cli` currently has a separate known failure in `commands_fs_tests::push_uses_expected_etag_from_frontmatter`; treat that as an unrelated FS push issue, not a blocker for benchmark-only changes

## Core operations

The public API is VFS-first.

| Operation | Meaning |
| --- | --- |
| `read_node` | Read one node by path |
| `list_nodes` | List nodes under a prefix |
| `write_node` | Replace the full content of a node |
| `append_node` | Append text to the end of a node |
| `edit_node` | Plain-text find/replace |
| `multi_edit_node` | Multiple atomic plain-text replacements |
| `mkdir_node` | Validate a directory-like path without persisting a directory row |
| `move_node` | Rename one node path |
| `delete_node` | Tombstone delete |
| `glob_nodes` | Shell-style path matching |
| `recent_nodes` | Recently updated nodes |
| `search_nodes` | Full-text search across current content |
| `export_snapshot` | Export the current snapshot |
| `fetch_updates` | Fetch changes since a known snapshot revision |

## Use with any AI SDK

This repo already ships the tool schema and dispatch layer.  
You do not need to hand-write tool definitions for every app.

The reusable pieces live in:

- client: [`crates/wiki_cli/src/client.rs`](crates/wiki_cli/src/client.rs)
- tool layer: [`crates/wiki_cli/src/agent_tools.rs`](crates/wiki_cli/src/agent_tools.rs)

The basic pattern is:

1. create a canister client
2. hand the SDK the generated tools
3. dispatch tool calls back into `handle_*_tool_call`

## OpenAI-compatible tool calling

```rust
use anyhow::Result;
use wiki_cli::agent_tools::{create_openai_tools, handle_openai_tool_call};
use wiki_cli::client::CanisterWikiClient;

async fn run() -> Result<()> {
    let client = CanisterWikiClient::new(
        "http://127.0.0.1:4943",
        "aaaaa-aa",
    )
    .await?;

    let tools = create_openai_tools();

    // Pass `tools` into your OpenAI-compatible SDK request.
    // When the model returns a tool call:
    let result = handle_openai_tool_call(
        &client,
        "append",
        r#"{"path":"/Wiki/memory.md","content":"remember this"}"#,
    )
    .await?;

    println!("{}", result.text);
    Ok(())
}
```

The tool names are:

- `read`
- `write`
- `append`
- `edit`
- `ls`
- `mkdir`
- `mv`
- `glob`
- `recent`
- `multi_edit`
- `rm`
- `search`

## Anthropic-compatible tool calling

```rust
use anyhow::Result;
use serde_json::json;
use wiki_cli::agent_tools::{create_anthropic_tools, handle_anthropic_tool_call};
use wiki_cli::client::CanisterWikiClient;

async fn run() -> Result<()> {
    let client = CanisterWikiClient::new(
        "http://127.0.0.1:4943",
        "aaaaa-aa",
    )
    .await?;

    let tools = create_anthropic_tools();

    // Pass `tools` into your Anthropic-compatible SDK request.
    // When the model returns a tool_use block:
    let result = handle_anthropic_tool_call(
        &client,
        "ls",
        json!({
            "prefix": "/Wiki",
            "recursive": false,
            "include_deleted": false
        }),
    )
    .await?;

    println!("{}", result.text);
    Ok(())
}
```

## Direct tool access

If you do not want to integrate through a chat SDK yet, you can still use the same layer directly.

```rust
use anyhow::Result;
use serde_json::json;
use wiki_cli::agent_tools::handle_anthropic_tool_call;
use wiki_cli::client::CanisterWikiClient;

async fn run() -> Result<()> {
    let client = CanisterWikiClient::new(
        "http://127.0.0.1:4943",
        "aaaaa-aa",
    )
    .await?;

    let result = handle_anthropic_tool_call(
        &client,
        "search",
        json!({
            "query_text": "architecture",
            "prefix": "/Wiki",
            "top_k": 5
        }),
    )
    .await?;

    println!("{}", result.text);
    Ok(())
}
```

## Use with the CLI

The CLI lives in [`crates/wiki_cli`](crates/wiki_cli).

Main commands:

- `read-node`
- `list-nodes`
- `write-node`
- `append-node`
- `edit-node`
- `multi-edit-node`
- `mkdir-node`
- `move-node`
- `glob-nodes`
- `recent-nodes`
- `delete-node`
- `search-remote`
- `status`
- `lint-local`
- `pull`
- `push`

Examples:

```bash
wiki-cli read-node --path /Wiki/notes.md
wiki-cli glob-nodes '**/*.md' --path /Wiki --node-type file
wiki-cli recent-nodes --limit 20 --path /Wiki
wiki-cli append-node --path /Wiki/log.md --input ./entry.md
wiki-cli move-node --from-path /Wiki/draft.md --to-path /Wiki/archive/draft.md --expected-etag etag-1 --overwrite
```

Notes:

- `append_node` appends content only when the node already exists. `kind` and `metadata_json` are only used when append creates a new node.
- `move_node --overwrite` replaces a live target or revives a tombstoned target at the destination path.
- `glob_nodes` rejects overlong patterns, but stored node paths do not make the entire glob query fail just because they are long.

## Use with Obsidian

The plugin lives in [`plugins/kinic-wiki`](plugins/kinic-wiki).

It is responsible for:

- pulling remote nodes into `Wiki/`
- pushing local changes back to the canister
- deleting mirrored files remotely
- writing conflict notes when `etag` mismatches occur

Mirror mapping:

- remote `/Wiki/foo.md` -> local `Wiki/foo.md`
- remote `/Wiki/nested/bar.md` -> local `Wiki/nested/bar.md`
- conflict file -> `Wiki/conflicts/<short-name>--<hash>.conflict.md` (`/Wiki/a/foo.md` -> `Wiki/conflicts/a__foo--<hash>.conflict.md`)

Managed mirror frontmatter:

- `path`
- `kind`
- `etag`
- `updated_at`
- `mirror: true`

The plugin is still sync-first.  
It already understands the new VFS API shape, but it does not yet expose separate UI commands for `append`, `glob`, `recent`, or `multi_edit`.

## Data model

The source of truth is a `Node`.

Main fields:

- `path`
- `kind`
- `content`
- `created_at`
- `updated_at`
- `etag`
- `deleted_at`
- `metadata_json`

Persisted node kinds:

- `file`
- `source`

List-only entry kinds:

- `directory`
- `file`
- `source`

Directories are virtual.
They appear in `list_nodes` and `glob_nodes`, but they are not persisted as rows.

Main tables:

- `fs_nodes`
- `fs_nodes_fts`
- `fs_change_log`

## Conflict model

Concurrency is controlled with `etag`, which is a content digest for the current node state.

- create: `expected_etag = None`
- update: current `etag` must match
- delete: current `etag` must match
- stale writes fail instead of silently merging

Deletes are tombstones.
Moves are path renames, not copy-plus-delete at the API boundary.

## Search

Search is built into the same SQLite store.

- backend: SQLite FTS
- target: current non-deleted content
- prefix scoping supported

There is no separate canister-only search implementation.

## Sync

Sync uses:

- `export_snapshot` for full export
- `fetch_updates` for delta sync

If the client does not know a valid snapshot revision, `fetch_updates` returns a full refresh instead of erroring.

Scope changes compare the known snapshot scope against the current scope:

- tombstones stay in `changed_nodes` when `include_deleted=true`
- tombstones move to `removed_paths` when `include_deleted=false`
- moved old paths appear in `removed_paths`, but they are not treated as tombstones

For rename operations, sync observes:

- new path in `changed_nodes`
- old path in `removed_paths`

## Current architecture

- canister: [`crates/wiki_canister`](crates/wiki_canister)
- runtime: [`crates/wiki_runtime`](crates/wiki_runtime)
- store: [`crates/wiki_store`](crates/wiki_store)
- public types: [`crates/wiki_types`](crates/wiki_types)
- CLI: [`crates/wiki_cli`](crates/wiki_cli)
- Obsidian plugin: [`plugins/kinic-wiki`](plugins/kinic-wiki)

Important implementation notes:

- search, sync, and writes share the same SQLite database
- canister init / post-upgrade runs FS migrations only
- the public contract is defined in [`crates/wiki_canister/wiki.did`](crates/wiki_canister/wiki.did)

## Build

Canister build script:
[`scripts/build-wiki-canister.sh`](scripts/build-wiki-canister.sh)

Build flow:

1. `cargo build --target wasm32-wasip1 -p wiki-canister`
2. `wasi2ic`
3. `ic-wasm` embeds `candid:service`

Diagnostic profiles:

- `WIKI_CANISTER_DIAGNOSTIC_PROFILE=baseline`
- `WIKI_CANISTER_DIAGNOSTIC_PROFILE=fts_disabled_for_bench`

Project build config:
[`icp.yaml`](icp.yaml)

## Development checks

Rust:

```bash
cargo test
cargo build --target wasm32-wasip1 -p wiki-canister
ICP_WASM_OUTPUT_PATH=/tmp/wiki_canister_test.wasm bash scripts/build-wiki-canister.sh
```

Plugin:

```bash
cd plugins/kinic-wiki
npm run check
```

## Not in scope

These are intentionally not implemented right now:

- `tag`
- binary node support
- multi-tenant wire shape
- directory tree move
- persisted directory rows

This project is not trying to be a full POSIX filesystem.  
It is trying to be a practical, file-oriented memory layer for agents and humans sharing the same knowledge space.
