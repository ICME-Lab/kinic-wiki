#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/bench/run_canister_vfs_fresh_compare.sh
# What: Run fresh-replica baseline vs FTS-off deployed canister comparisons.
# Why: The FTS cost question is only meaningful when each profile starts from a clean local replica.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

require_command "dfx" "DFX is required to manage a fresh local replica."
require_command "icp" "The icp CLI is required to deploy and inspect local canisters."
require_command "cargo" "Rust toolchain is required to build the benchmark client."
require_command "node" "Node.js is required to assemble comparison summaries."

RESULT_DIR="$(bench_results_dir "canister_vfs_fresh_compare")"
RAW_DIR="$(bench_raw_dir "${RESULT_DIR}")"
SUMMARY_FILE="${RESULT_DIR}/summary.txt"
CONFIG_FILE="${RESULT_DIR}/config.txt"
ENVIRONMENT_FILE="${RESULT_DIR}/environment.txt"
write_summary_header "${SUMMARY_FILE}" "canister_vfs_fresh_compare"
write_environment_json "${ENVIRONMENT_FILE}"

stop_replica() {
  dfx stop >/dev/null 2>&1 || true
}

start_clean_replica() {
  stop_replica
  dfx start --clean --background >/dev/null
}

deploy_profile() {
  local profile="$1"
  bench_log "deploy ${profile} on fresh replica"
  WIKI_CANISTER_DIAGNOSTIC_PROFILE="${profile}" icp deploy wiki -e local -y >/dev/null
}

capture_profile_status() {
  local profile="$1"
  local output_file="$2"
  icp canister status --json wiki -e local > "${output_file}"
  node -e '
    const fs = require("fs");
    const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(payload.id);
  ' "${output_file}"
}

extract_summary_path() {
  local output_text="$1"
  printf '%s\n' "${output_text}" | awk -F= '/^summary=/{print $2}' | tail -n 1
}

run_profile_benches() {
  local profile="$1"
  start_clean_replica
  deploy_profile "${profile}"
  local status_file="${RAW_DIR}/${profile}.status.txt"
  local canister_id
  canister_id="$(capture_profile_status "${profile}" "${status_file}")"
  local latency_output
  local workload_output
  latency_output="$(
    BENCH_REPLICA_RESET_MODE="clean_start" \
    WIKI_CANISTER_DIAGNOSTIC_PROFILE="${profile}" \
    CANISTER_ID="${canister_id}" \
    LATENCY_ITERATIONS_1K=0 \
    LATENCY_ITERATIONS_10K=10 \
    LATENCY_ITERATIONS_100K=5 \
    LATENCY_ITERATIONS_1MB=0 \
    LATENCY_WARMUP_ITERATIONS=0 \
    bash "${SCRIPT_DIR}/run_canister_vfs_latency.sh"
  )"
  workload_output="$(
    BENCH_REPLICA_RESET_MODE="clean_start" \
    WIKI_CANISTER_DIAGNOSTIC_PROFILE="${profile}" \
    CANISTER_ID="${canister_id}" \
    WORKLOAD_OPERATIONS="update" \
    WORKLOAD_DIRECTORY_SHAPES="flat" \
    WORKLOAD_FILE_COUNT=10 \
    WORKLOAD_CONCURRENT_CLIENTS=1 \
    WORKLOAD_ITERATIONS_1K=0 \
    WORKLOAD_ITERATIONS_10K=5 \
    WORKLOAD_ITERATIONS_100K=3 \
    WORKLOAD_ITERATIONS_1MB=0 \
    bash "${SCRIPT_DIR}/run_canister_vfs_workload.sh"
  )"
  local latency_summary
  local workload_summary
  latency_summary="$(extract_summary_path "${latency_output}")"
  workload_summary="$(extract_summary_path "${workload_output}")"
  {
    printf 'profile=%s\n' "${profile}"
    printf 'replica_host=%s\n' "${replica_host}"
    printf 'canister_id=%s\n' "${canister_id}"
    printf 'latency_summary=%s\n' "${latency_summary}"
    printf 'workload_summary=%s\n' "${workload_summary}"
  } > "${RAW_DIR}/${profile}.meta.txt"
  stop_replica
}

trap stop_replica EXIT

node -e '
  const fs = require("fs");
  const workloadMatrix = [
    "update_flat_n10_p10240_c1_preview_none",
    "update_flat_n10_p102400_c1_preview_none"
  ];
  fs.writeFileSync(process.argv[1], JSON.stringify({
    tool: "canister_vfs_fresh_compare",
    reset_mode: "clean_start",
    profiles: ["baseline", "fts_disabled_for_bench"],
    latency_matrix: [
      "write_node_single_10k",
      "append_node_single_10k",
      "write_node_single_100k",
      "append_node_single_100k"
    ],
    workload_matrix: workloadMatrix
  }, null, 2) + "\n");
' "${CONFIG_FILE}"

run_profile_benches "baseline"
run_profile_benches "fts_disabled_for_bench"

node -e '
  const fs = require("fs");
  const [summaryFile, envFile, rawDir] = process.argv.slice(1);
  const parseMeta = filePath => Object.fromEntries(
    fs.readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .map(line => line.split(/=(.*)/s).slice(0, 2))
  );
  const parseSummary = filePath => {
    const result = {};
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    let current = null;
    for (const line of lines) {
      if (line === "") {
        if (current && current.scenario) result[current.scenario] = current;
        current = null;
        continue;
      }
      const [key, value] = line.split(/=(.*)/s).slice(0, 2);
      if (key === "scenario") {
        if (current && current.scenario) result[current.scenario] = current;
        current = { scenario: value };
        continue;
      }
      if (current) {
        current[key] = value;
      }
    }
    if (current && current.scenario) result[current.scenario] = current;
    return result;
  };
  const baselineMeta = parseMeta(`${rawDir}/baseline.meta.txt`);
  const ftsMeta = parseMeta(`${rawDir}/fts_disabled_for_bench.meta.txt`);
  const baselineLatency = parseSummary(baselineMeta.latency_summary);
  const ftsLatency = parseSummary(ftsMeta.latency_summary);
  const baselineWorkload = parseSummary(baselineMeta.workload_summary);
  const ftsWorkload = parseSummary(ftsMeta.workload_summary);
  const scenarios = [
    ["write_node_single_10k", baselineLatency, ftsLatency],
    ["append_node_single_10k", baselineLatency, ftsLatency],
    ["write_node_single_100k", baselineLatency, ftsLatency],
    ["append_node_single_100k", baselineLatency, ftsLatency],
    ["update_flat_n10_p10240_c1_preview_none", baselineWorkload, ftsWorkload],
    ["update_flat_n10_p102400_c1_preview_none", baselineWorkload, ftsWorkload]
  ];
  const requireScenario = (scenarioSet, name, label) => {
    const scenario = scenarioSet[name];
    if (!scenario) {
      throw new Error(`missing ${label} scenario: ${name}`);
    }
    return scenario;
  };
  const ratio = (base, compare) => {
    const b = BigInt(base);
    const c = BigInt(compare);
    return Number((b * 1000n) / c) / 1000;
  };
  const env = JSON.parse(fs.readFileSync(envFile, "utf8"));
  env.replica_reset_mode = "clean_start";
  env.diagnostic_profile = "baseline_vs_fts_disabled_for_bench";
  fs.writeFileSync(envFile, JSON.stringify(env, null, 2) + "\n");
  const lines = [
    fs.readFileSync(summaryFile, "utf8").trimEnd(),
    `baseline_replica_host=${baselineMeta.replica_host}`,
    `baseline_canister_id=${baselineMeta.canister_id}`,
    `baseline_latency_summary=${baselineMeta.latency_summary}`,
    `baseline_workload_summary=${baselineMeta.workload_summary}`,
    `fts_disabled_replica_host=${ftsMeta.replica_host}`,
    `fts_disabled_canister_id=${ftsMeta.canister_id}`,
    `fts_disabled_latency_summary=${ftsMeta.latency_summary}`,
    `fts_disabled_workload_summary=${ftsMeta.workload_summary}`,
    ""
  ];
  for (const [name, baselineSet, ftsSet] of scenarios) {
    const baseline = requireScenario(baselineSet, name, "baseline");
    const fts = requireScenario(ftsSet, name, "fts_disabled_for_bench");
    lines.push(`scenario=${name}`);
    lines.push(`baseline_cycles_per_measured_request=${baseline.cycles_per_measured_request}`);
    lines.push(`fts_disabled_cycles_per_measured_request=${fts.cycles_per_measured_request}`);
    lines.push(`cycles_ratio_baseline_over_fts_disabled=${ratio(baseline.cycles_per_measured_request, fts.cycles_per_measured_request)}`);
    lines.push(`baseline_avg_latency_us=${baseline.avg_latency_us}`);
    lines.push(`fts_disabled_avg_latency_us=${fts.avg_latency_us}`);
    lines.push(`baseline_avg_request_payload_bytes=${baseline.avg_request_payload_bytes}`);
    lines.push(`fts_disabled_avg_request_payload_bytes=${fts.avg_request_payload_bytes}`);
    lines.push(`baseline_avg_response_payload_bytes=${baseline.avg_response_payload_bytes}`);
    lines.push(`fts_disabled_avg_response_payload_bytes=${fts.avg_response_payload_bytes}`);
    lines.push("");
  }
  fs.writeFileSync(summaryFile, lines.join("\n"));
  console.log(lines.join("\n"));
' "${SUMMARY_FILE}" "${ENVIRONMENT_FILE}" "${RAW_DIR}" >/dev/null

bench_log "fresh compare results saved to ${RESULT_DIR}"
printf 'summary=%s\n' "${SUMMARY_FILE}"
