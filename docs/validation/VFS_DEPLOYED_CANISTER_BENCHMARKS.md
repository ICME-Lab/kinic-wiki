# VFS Deployed Canister Benchmarks

This document defines the benchmark contract for deployed canisters accessed through `ic-agent`.
It is not a host-filesystem benchmark. It measures public canister API behavior directly.

Primary metrics:

- `cycles`
- `latency`
- `wire IO`

## Benchmark Suites

| Bench | Role | Main targets |
| --- | --- | --- |
| `canister_vfs_workload` | repeated API workload benchmark | `create`, `update`, `append`, `edit`, `move_same_dir`, `move_cross_dir`, `delete`, `read`, `list`, `search`, `mkdir`, `glob`, `recent`, `multi_edit` |
| `canister_vfs_latency` | single-update latency benchmark | `write_node`, `append_node` |

`query` is treated as a documentation category covering `read`, `list`, `search`, `mkdir`, `glob`, and `recent`, not as a separate method name.

## Fixed Conditions

| Item | Value |
| --- | --- |
| Payload sizes | `1k`, `10k`, `100k`, `1MB` |
| Workload file count | `100` |
| Concurrency | `1` |
| Transport | `ic-agent` |
| Cycles source | `icp canister status --json` |
| Update cycles scope | `isolated_single_op` |
| Query cycles scope | `isolated_single_op` for `read`, `list`, `search`, `glob`, `recent` |
| Validation-only query scope | `scenario_total` for `mkdir` |

`isolated_single_op` separates setup from the measured call and uses `measured_cycles_delta` plus `cycles_per_measured_request` as the main table.

## Required Artifacts

Each run must write to one of:

- `.benchmarks/results/canister_vfs_workload/<timestamp>/`
- `.benchmarks/results/canister_vfs_latency/<timestamp>/`

Each run must include:

- `summary.txt`
- `config.txt`
- `environment.txt`
- `raw/*.txt`

Artifact roles:

- `summary.txt`: human-readable summary with `generated_at_utc`
- `config.txt`: effective configuration as JSON text
- `environment.txt`: execution environment as JSON text
- `raw/*.txt`: per-scenario aggregated data as JSON text

## Stored Metrics

Each scenario must record:

- `measurement_mode`
- `setup_request_count`
- `measured_request_count`
- `cycles_before`
- `cycles_after`
- `cycles_delta`
- `cycles_per_request`
- `cycles_per_measured_request`
- `setup_cycles_delta`
- `measured_cycles_delta`
- `cycles_error`
- `cycles_source`
- `cycles_scope`
- `total_seconds`
- `avg_latency_us`
- `p50_latency_us`
- `p95_latency_us`
- `p99_latency_us`
- `request_count`
- `total_request_payload_bytes`
- `total_response_payload_bytes`
- `avg_request_payload_bytes`
- `avg_response_payload_bytes`
- `openai_tool`
- `openai_tool_variant`

If cycles cannot be collected, the benchmark should continue. Cycles fields become `null` and the reason is written to `cycles_error`.

## Operation Definitions

| Operation | OpenAI tool | API | Definition |
| --- | --- | --- | --- |
| `create` | `write` (`variant=create`) | `write_node` | write a new path with `expected_etag = None` |
| `update` | `write` (`variant=overwrite`) | `write_node` | overwrite an existing path with `expected_etag = Some(current_etag)` |
| `append` | `append` | `append_node` | append target payload to a small seeded node |
| `edit` | `edit` | `edit_node` | replace a fixed token pair |
| `move_same_dir` | `mv` (`variant=same_dir`) | `move_node` | rename within the same parent |
| `move_cross_dir` | `mv` (`variant=cross_dir`) | `move_node` | rename into another parent |
| `delete` | `rm` | `delete_node` | delete a seeded node |
| `read` | `read` | `read_node` | read a seeded node |
| `list` | `ls` | `list_nodes` | list a seeded prefix |
| `search` | `search` | `search_nodes` | run a hit-producing search against a seeded corpus |
| `mkdir` | `mkdir` | `mkdir_node` | validate a unique path per iteration |
| `glob` | `glob` | `glob_nodes` | run `pattern=node-*.md` within the bench prefix |
| `recent` | `recent` | `recent_nodes` | read recent nodes with `limit = min(10, file_count)` |
| `multi_edit` | `multi_edit` | `multi_edit_node` | apply two atomic token replacements |

## Update ACK Contract

| Method | Response shape |
| --- | --- |
| `write_node` | `path`, `kind`, `updated_at`, `etag`, `created` |
| `append_node` | `path`, `kind`, `updated_at`, `etag`, `created=false` |
| `edit_node` | `path`, `kind`, `updated_at`, `etag`, `replacement_count` |
| `move_node` | `from_path`, `path`, `kind`, `updated_at`, `etag`, `overwrote` |
| `delete_node` | `path` |
| `multi_edit_node` | `path`, `kind`, `updated_at`, `etag`, `replacement_count` |

Update operations return lightweight acknowledgements, not full node bodies. Any caller that needs content after a write must issue `read_node` separately.

## Interpretation Rules

- treat `measured_cycles_delta` and `cycles_per_measured_request` as the primary update-cost metrics
- treat `scenario_total` as supplemental only
- keep failed scenarios in both `raw/*.txt` and `summary.txt`
- read deployed benchmarks as API-contract measurements, not filesystem throughput numbers
- keep scaling responsibility for snapshot/export/update workloads in `canbench`

## Supporting Scripts

- `scripts/bench/run_canister_vfs_workload.sh`
- `scripts/bench/run_canister_vfs_latency.sh`
- `scripts/bench/run_canister_vfs_fresh_compare.sh`

Both workload and latency wrappers build `vfs_bench` from the workspace root and use either `CARGO_TARGET_DIR/.../debug/vfs_bench` or the default `<repo>/target/debug/vfs_bench`.
