#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/bench/run_beam_prepare.sh
# What: Prepare a BEAM benchmark namespace before read-only eval.
# Why: Note import and index sync must happen outside `beam_bench`.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}"
cargo run -p vfs-cli --bin beam_prepare -- "$@"
