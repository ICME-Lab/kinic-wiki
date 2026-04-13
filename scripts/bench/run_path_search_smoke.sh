#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/bench/run_path_search_smoke.sh
# What: Run a lightweight local smoke benchmark for case-insensitive path search.
# Why: search_node_paths is intentionally outside FTS, so we want a cheap latency/hit-count check.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"

cargo test -p wiki-store --test fs_store_scale path_search_smoke_reports_latency_and_hits -- --nocapture
