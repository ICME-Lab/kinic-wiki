#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/run_canbench_scale.sh
# What: Run repeated scale-focused canbench suites and materialize review artifacts.
# Why: Design review needs raw run logs, aggregated statistics, and comparable output files from a single entrypoint.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ARTIFACT_ROOT="${REPO_ROOT}/artifacts/canbench"
RUN_ID="${CANBENCH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
RUNS_DIR="${ARTIFACT_ROOT}/runs/${RUN_ID}"
REPEATS="${CANBENCH_REPEATS:-3}"

mkdir -p "${RUNS_DIR}"

run_index=1
while [[ "${run_index}" -le "${REPEATS}" ]]; do
  run_dir="${RUNS_DIR}/run-$(printf '%02d' "${run_index}")"
  mkdir -p "${run_dir}"
  bash "${REPO_ROOT}/scripts/run_canbench_guard.sh" --show-canister-output --less-verbose > "${run_dir}/canbench.log" 2>&1
  cp "${REPO_ROOT}/canbench_results.yml" "${run_dir}/canbench_results.yml"
  run_index="$((run_index + 1))"
done

python3 -m scripts.canbench.aggregate --runs-dir "${RUNS_DIR}" --output-dir "${ARTIFACT_ROOT}"
