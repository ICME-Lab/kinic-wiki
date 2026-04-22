#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/bench/run_beam_bench.sh
# What: Run the read-only BEAM-derived retrieval benchmark binary.
# Why: Eval must stay separate from namespace preparation and canister writes.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}"
cargo run -p wiki-cli --bin beam_bench -- "$@"
