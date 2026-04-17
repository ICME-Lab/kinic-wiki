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
- `/Wiki/...` as the primary wiki root
- `/Sources/...` for raw and session source nodes

## Connection Resolution

`wiki-cli` resolves the target canister in this order:

1. `--local`
2. default mainnet host `https://icp0.io`

`canister_id` resolves separately:

1. `--canister-id`
2. `WIKI_CANISTER_ID`
3. user config

Host selection flag:

- `--local`

Environment variables:

- `WIKI_CANISTER_ID`

User config paths:

- `~/.config/wiki-cli/config.toml`
- `~/.wiki-cli.toml`

Config format:

```toml
canister_id = "aaaaa-aa"
```

## Source And Maintenance

`wiki-cli` is VFS-first.
Agents read, search, and edit nodes directly, then call explicit maintenance commands when needed.

Source node conventions:

- raw source path: `/Sources/raw/<source_id>/<source_id>.md`
- session source path: `/Sources/sessions/<session_id>/<session_id>.md`
- new source nodes: `write-node --kind source`
- append to existing source nodes: `append-node --kind source`
- when `kind=source`, CLI lightly validates the canonical path form above

System maintenance commands:

- `wiki-cli rebuild-index`

Typical flow:

1. Read `index.md` and related durable pages with VFS commands.
2. Search with `search-remote`, `search-path-remote`, `glob-nodes`, or `recent-nodes` when needed.
3. Write or edit `/Wiki/...` and `/Sources/...` nodes directly.
4. Run `rebuild-index` after durable wiki updates when index entries may have changed.

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
- deployed canister benchmark guide: [`VFS_DEPLOYED_CANISTER_BENCHMARKS.md`](VFS_DEPLOYED_CANISTER_BENCHMARKS.md)

Minimum validation commands:

- `cargo test --workspace`
- `cd plugins/kinic-wiki && npm run check`
- `bash scripts/build-wiki-canister-canbench.sh`

If your environment has the fixed canbench runtime, also run:

- `bash scripts/run_canbench_guard.sh`

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

- deployed canister benchmarks: `run_canister_vfs_workload.sh`, `run_canister_vfs_latency.sh`
- VFS-native scaling benchmarks: `canbench` for `write`, `append`, `move`, `search`, `export_snapshot`, `fetch_updates`
- memory-quality benchmark harness: `scripts/bench/run_beam_bench.sh` for BEAM-style retrieval evaluation over imported wiki notes

## BEAM Benchmark Harness

`scripts/bench/run_beam_bench.sh` is a development benchmark harness, separate from both `wiki-cli` and `canbench`.

- `canbench` measures canister-side API scale and instructions
- `beam-bench` measures retrieval quality after importing long conversations into `/Wiki/<namespace>/...`
- Codex CLI e2e over `wiki-cli` read-only commands
- read-only tool/command access only
- artifacts: `summary.json`, `results.jsonl`, `failures.jsonl`, `report.md`

Default evaluation mode is now `retrieve-and-extract`.

- primary metrics focus on factoid questions only
- `--questions-per-conversation` applies after primary question-class filtering
- retrieval hit rate and short-answer match rate are reported separately

Example:

```bash
bash scripts/bench/run_beam_bench.sh \
  --local \
  --canister-id aaaaa-aa \
  --dataset-path fixtures/beam/beam_sample.json \
  --split 100K \
  --output-dir artifacts/beam-sample \
  --eval-mode retrieve-and-extract \
  --top-k 5 \
  --limit 1 \
  --questions-per-conversation 1 \
  --parallelism 1
```

The example above uses the local replica.
Normal mainnet usage can omit host flags.
Local usage can use `--local`.
Only `canister_id` still needs `--canister-id`, `WIKI_CANISTER_ID`, or user config.

The harness imports each conversation under a normal wiki path such as `/Wiki/bench-run-<timestamp>/<conversation_id>/` and keeps probing answers out of the wiki notes. Codex defaults to `danger-full-access` so the child process can reach the local PocketIC gateway. This command is intended for manual or dedicated benchmark runs rather than normal CI.

Manual deployed canister benchmarks:

- `bash scripts/bench/run_canister_vfs_workload.sh`
- `CANISTER_ID=<id> bash scripts/bench/run_canister_vfs_latency.sh`
- `bash scripts/bench/run_canister_vfs_fresh_compare.sh`

`run_canister_vfs_workload.sh` is local-only and resolves the local `wiki` canister id from `.icp/cache/mappings/local.ids.json` when `--canister-id` and `CANISTER_ID` are both absent. Use manual canister id injection only when measuring a different canister on purpose.

These runs target an already deployed canister through `ic-agent`. They complement `canbench`: `canbench` is for canister-side scaling and instruction trends, while deployed canister bench is for API-level `cycles + latency + wire IO`.

The deployed benchmark artifacts are written to `.benchmarks/results/<tool>/<timestamp>/` and always include:

- `summary.txt` for the human-facing summary
  includes both compact `timestamp` and human-readable `generated_at_utc`
  includes the resolved `canister_id`
- `config.txt` for the true benchmark settings as JSON text
- `environment.txt` for the execution environment plus `replica_host`, `canister_id`, `bench_transport`, `canister_status_source`
- `raw/*.txt` for scenario-level aggregated source data as JSON text

`run_canister_vfs_workload.sh` covers repeated request workloads, `run_canister_vfs_latency.sh` covers single-update latency, and `run_canister_vfs_fresh_compare.sh` is the clean-room entrypoint for FTS diagnosis.

The contract for measurement mode, operation matrix, artifact format, and interpretation is maintained in [`VFS_DEPLOYED_CANISTER_BENCHMARKS.md`](VFS_DEPLOYED_CANISTER_BENCHMARKS.md). README keeps only the entrypoints and the high-level role split.

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
| `delete_node` | Physical delete |
| `glob_nodes` | Shell-style path matching |
| `recent_nodes` | Recently updated nodes |
| `search_nodes` | Full-text search across current content with compact preview snippets |
| `search_node_paths` | Case-insensitive substring search across current node paths and filenames |
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

## Interface boundaries

This project has one shared canister client and two primitive interfaces on top of it.

- `client`
- `agent tools`
- `CLI commands`
- `skills`

### Shared client

`client` is the common transport layer that talks to the canister.

Both agent tools and CLI commands use the same client layer and ultimately call the same canister methods such as `read_node`, `write_node`, `search_nodes`, and `move_node`.

Conceptually:

```text
LLM tool call
  -> agent_tools
  -> client
  -> canister

shell command
  -> CLI commands
  -> client
  -> canister
```

### Agent tools

Agent tools are the agent-facing primitive interface.

They are intended for hosts that support tool calling, such as an app built on top of the OpenAI Responses API or Anthropic tool use. In that setup, the host creates tool schemas with `create_*_tools()` and dispatches tool calls with `handle_*_tool_call()`.

Agent tools are not shell commands. They are JSON-shaped tool definitions and dispatch helpers for LLM runtimes.

Use agent tools when:

- an LLM host already supports tool calling
- the model should call primitive wiki operations directly
- you want a tool surface that stays close to the VFS model

Current agent tools:

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
- `search_paths`

### CLI commands

CLI commands are the shell-facing primitive interface.

They are intended for humans, scripts, and coding agents that can run terminal commands directly. The CLI exposes remote VFS operations, sync flows, and maintenance commands through `wiki-cli ...`.

Use CLI commands when:

- working from a shell or script
- integrating with coding agents that already have terminal access
- running sync or maintenance flows such as `pull`, `push`, or `rebuild-index`

### Skills

Skills are the high-level workflow layer.

Skills should orchestrate multiple primitive operations from the agent tools or the CLI. For the wiki workflow described in `idea.md`, the main skills are:

- `ingest`
- `query`
- `lint`

A useful helper skill may also exist for source normalization, such as PDF-to-Markdown conversion, but that should remain a sub-workflow under ingest rather than a new core system boundary.

## Agent tool to CLI mapping

The agent tool surface is intentionally close to the remote VFS command surface.

| Agent tool | CLI command | Purpose |
| --- | --- | --- |
| `read` | `read-node` | read one node |
| `write` | `write-node` | replace full node content |
| `append` | `append-node` | append content |
| `edit` | `edit-node` | plain-text replacement |
| `ls` | `list-nodes` | list nodes under a prefix |
| `mkdir` | `mkdir-node` | validate a directory-like path |
| `mv` | `move-node` | move or rename a node |
| `glob` | `glob-nodes` | path globbing |
| `recent` | `recent-nodes` | recently updated nodes |
| `multi_edit` | `multi-edit-node` | multiple replacements in one operation |
| `rm` | `delete-node` | delete a node |
| `search` | `search-remote` | full-text content search |
| `search_paths` | `search-path-remote` | path and filename search |

Not every CLI command has an agent tool equivalent. Sync and maintenance commands stay CLI-only for now.

Examples:

- `rebuild-index`
- `status`
- `pull`
- `push`
- `lint-local`

## Design intent

The design intent is:

- keep the shared client as the single canister access layer
- keep agent tools raw and composable
- keep CLI commands raw and operational
- keep high-level workflows in skills

This separation keeps the primitive interface small while allowing higher-level wiki behavior to evolve independently.

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
            "recursive": false
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
- `delete-tree`
- `search-remote`
- `search-path-remote`
- `rebuild-index`
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
wiki-cli delete-tree --path /Wiki/archive
```

Notes:

- `append_node` appends content only when the node already exists. `kind` and `metadata_json` are only used when append creates a new node.
- `move_node --overwrite` replaces a live target or reuses a previously deleted destination path.
- `delete-node` deletes one node path. `delete-tree` deletes all node paths under a prefix, deepest-first.
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

Fresh bootstrap creates the current rowid-backed schema directly.
Legacy `fs_nodes(path PRIMARY KEY, ...)` databases are not auto-migrated anymore and must be rebuilt before using the current canister bootstrap.

## Conflict model

Concurrency is controlled with `etag`, which is a content digest for the current node state.

- create: `expected_etag = None`
- update: current `etag` must match
- delete: current `etag` must match
- stale writes fail instead of silently merging

Deletes physically remove the node row.
Moves are path renames, not copy-plus-delete at the API boundary.

## Search

Search is built into the same SQLite store.

- backend: SQLite FTS
- target: current content
- prefix scoping supported

There is no separate canister-only search implementation.

## Sync

Sync uses:

- `export_snapshot` for full export
- `fetch_updates` for delta sync

Both sync APIs are paged. Requests must set `limit` in `1..=100`; responses return
`next_cursor` when another page exists. The cursor is the last absolute path from the previous
page. Clients must not persist a new `snapshot_revision` until the final page.
`export_snapshot` also returns `snapshot_session_id`; paged snapshot requests must resend it from
page 2 onward so the server can keep a fixed path set for the session lifetime.

`fetch_updates` only returns deltas. If the client does not know a valid snapshot revision, changes
scope, or sends a future revision, `fetch_updates` returns an error instead of a full refresh.
Change-log rows are retained in SQLite until storage is exhausted, so old valid revisions can still
produce deltas.
Paged delta race checks use a per-path `last_change_revision` index. Paths whose latest revision is
still at or before `target_snapshot_revision` may be returned from current state; paths updated
again after that target still fail hard.
If an existing database has already lost historical change-log rows, revisions before the available
log floor also return `known_snapshot_revision is no longer available`; clients must stop delta sync
and run an explicit snapshot resync.

Initial sync and scope changes must use `export_snapshot` first, then continue with
`fetch_updates` for the same scope. After paged `export_snapshot` completes, clients run paged
`fetch_updates` from that snapshot revision to catch concurrent writes before saving local sync
state:

`export_snapshot` is an update call so the server can persist `snapshot_session_id` across pages.
`fetch_updates` remains a query call. `export_snapshot` now fixes the path set per
`snapshot_session_id` and rejects later pages if any unread session path changed after the session
started. If a session path is updated, deleted, or renamed before its page is read, the server
returns `snapshot_revision is no longer current` and the client must restart snapshot sync. If a
session expires, the server returns `snapshot_session_id has expired` and the client must restart
snapshot sync. Continued snapshot requests validate `snapshot_session_id` first, then TTL, then
prefix, and only then validate that `cursor` is a valid session path.

- deleted paths appear in `removed_paths`
- moved old paths appear in `removed_paths`

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
