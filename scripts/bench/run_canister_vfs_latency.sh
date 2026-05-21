#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/bench/run_canister_vfs_latency.sh
# What: Run single-update latency benchmarks against a deployed canister.
# Why: We need a canister-side analogue to durable mutation latency without canbench.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

require_command "cargo" "Rust toolchain is required to build the vfs_bench client binary."
require_command "node" "Node.js is required to materialize JSON summaries."
require_command "icp" "The icp CLI is required to collect canister cycle costs."

CANISTER_ID="${CANISTER_ID:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --canister-id) CANISTER_ID="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "${CANISTER_ID}" ]]; then
  echo "usage: CANISTER_ID=... bash scripts/bench/run_canister_vfs_latency.sh" >&2
  exit 1
fi
REPLICA_HOST="${BENCH_REPLICA_HOST:-$(bench_replica_host)}"
LOCAL_ARGS=(--replica-host "${REPLICA_HOST}")
CLI_ARGS=(--allow-non-ii-identity "${LOCAL_ARGS[@]}")
CANISTER_STATUS_ENVIRONMENT="$(bench_icp_environment)"
unset CANISTER_STATUS_NETWORK

RESULT_DIR="$(bench_results_dir "canister_vfs_latency")"
RAW_DIR="$(bench_raw_dir "${RESULT_DIR}")"
SUMMARY_FILE="${RESULT_DIR}/summary.txt"
CONFIG_FILE="${RESULT_DIR}/config.txt"
ENVIRONMENT_FILE="${RESULT_DIR}/environment.txt"
write_summary_header "${SUMMARY_FILE}" "canister_vfs_latency"
write_environment_json "${ENVIRONMENT_FILE}"
augment_environment_json "${ENVIRONMENT_FILE}" "${REPLICA_HOST}" "${CANISTER_ID}" "ic-agent" "icp" "true"

bench_log "building vfs_bench binary"
cd "$(bench_repo_root)"
cargo build -p kinic-vfs-cli --bin vfs_bench --bin kinic-vfs-cli >/dev/null
BENCH_BIN="$(bench_vfs_bench_bin)"
CLI_BIN="$(bench_kinic_vfs_cli_bin)"
bench_log "creating benchmark database"
DATABASE_NAME="${DATABASE_NAME:-Benchmark latency}"
DATABASE_ID="$("${CLI_BIN}" "${CLI_ARGS[@]}" --canister-id "${CANISTER_ID}" database create "${DATABASE_NAME}")"
"${CLI_BIN}" "${CLI_ARGS[@]}" --canister-id "${CANISTER_ID}" database grant "${DATABASE_ID}" 2vxsx-fae writer >/dev/null
printf 'database_id=%s\n' "${DATABASE_ID}" >> "${SUMMARY_FILE}"

node -e '
  const fs = require("fs");
  const [configFile, replicaHost, canisterId] = process.argv.slice(1);
  const parseIterations = (value, fallback) => value ? Number(value) : fallback;
  const diagnosticProfile = process.env.VFS_CANISTER_DIAGNOSTIC_PROFILE || "baseline";
  const replicaResetMode = process.env.BENCH_REPLICA_RESET_MODE || null;
  const sizes = [
    { label: "1k", bytes: 1024, iterations: parseIterations(process.env.LATENCY_ITERATIONS_1K, 200) },
    { label: "10k", bytes: 10240, iterations: parseIterations(process.env.LATENCY_ITERATIONS_10K, 100) },
    { label: "100k", bytes: 102400, iterations: parseIterations(process.env.LATENCY_ITERATIONS_100K, 40) },
    { label: "1mb", bytes: 1048576, iterations: parseIterations(process.env.LATENCY_ITERATIONS_1MB, 10) }
  ];
  const warmup = parseIterations(process.env.LATENCY_WARMUP_ITERATIONS, 5);
  const scenarios = [];
  for (const size of sizes) {
    if (size.iterations <= 0) continue;
    scenarios.push({ scenario: `write_node_single_${size.label}`, operation: "write-node", payload_size_bytes: size.bytes, iterations: size.iterations, warmup_iterations: warmup, measurement_mode: "isolated_single_op" });
    scenarios.push({ scenario: `append_node_single_${size.label}`, operation: "append-node", payload_size_bytes: size.bytes, iterations: size.iterations, warmup_iterations: warmup, measurement_mode: "isolated_single_op" });
  }
  fs.writeFileSync(configFile, JSON.stringify({
    tool: "canister_vfs_latency",
    replica_host: replicaHost,
    canister_id: canisterId,
    benchmark_transport: "ic-agent",
    diagnostic_profile: diagnosticProfile,
    replica_reset_mode: replicaResetMode,
    payload_sizes: sizes,
    scenarios
  }, null, 2) + "\n");
' "${CONFIG_FILE}" "${REPLICA_HOST}" "${CANISTER_ID}"

append_summary() {
  local raw_file="$1"
  node -e '
    const fs = require("fs");
    const [rawFile] = process.argv.slice(1);
    const data = JSON.parse(fs.readFileSync(rawFile, "utf8"));
    const lines = [
      `scenario=${data.benchmark_name}`,
      `operation=${data.operation}`,
      `payload_size_bytes=${data.payload_size_bytes}`,
      `iterations=${data.iterations}`,
      `warmup_iterations=${data.warmup_iterations}`,
      `measurement_mode=${data.measurement_mode}`,
      `setup_request_count=${data.setup_request_count}`,
      `measured_request_count=${data.measured_request_count}`,
      `request_count=${data.request_count}`,
      `total_seconds=${data.total_seconds}`,
      `avg_latency_us=${data.avg_latency_us}`,
      `p50_latency_us=${data.p50_latency_us}`,
      `p95_latency_us=${data.p95_latency_us}`,
      `p99_latency_us=${data.p99_latency_us}`,
      `total_request_payload_bytes=${data.total_request_payload_bytes}`,
      `total_response_payload_bytes=${data.total_response_payload_bytes}`,
      `avg_request_payload_bytes=${data.avg_request_payload_bytes}`,
      `avg_response_payload_bytes=${data.avg_response_payload_bytes}`,
      `error=${data.error ?? null}`,
      `cycles_before=${data.cycles_before}`,
      `cycles_after=${data.cycles_after}`,
      `setup_cycles_delta=${data.setup_cycles_delta}`,
      `measured_cycles_delta=${data.measured_cycles_delta}`,
      `cycles_per_measured_request=${data.cycles_per_measured_request}`,
      `cycles_error=${data.cycles_error}`,
      `cycles_source=${data.cycles_source ?? null}`,
      `cycles_scope=${data.cycles_scope ?? null}`,
      `raw_file=${rawFile}`,
      ""
    ];
    console.log(lines.join("\n"));
  ' "${raw_file}" >> "${SUMMARY_FILE}"
}

write_failed_raw() {
  local raw_file="$1"
  local scenario="$2"
  local operation="$3"
  local payload_size="$4"
  local iterations="$5"
  local warmup_iterations="$6"
  local error_text="$7"
  node -e '
    const fs = require("fs");
    const [rawFile, scenario, operation, payloadSize, iterations, warmupIterations, errorText] = process.argv.slice(1);
    fs.writeFileSync(rawFile, JSON.stringify({
      benchmark_name: scenario,
      operation: operation.replaceAll("-", "_"),
      payload_size_bytes: Number(payloadSize),
      iterations: Number(iterations),
      warmup_iterations: Number(warmupIterations),
      request_count: 0,
      total_seconds: null,
      avg_latency_us: null,
      p50_latency_us: null,
      p95_latency_us: null,
      p99_latency_us: null,
      total_request_payload_bytes: null,
      total_response_payload_bytes: null,
      avg_request_payload_bytes: null,
      avg_response_payload_bytes: null,
      error: errorText
    }, null, 2) + "\n");
  ' "${raw_file}" "${scenario}" "${operation}" "${payload_size}" "${iterations}" "${warmup_iterations}" "${error_text}"
}

node -e '
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const scenario of data.scenarios) {
    console.log([scenario.scenario, scenario.operation, scenario.payload_size_bytes, scenario.iterations, scenario.warmup_iterations].join("|"));
  }
' "${CONFIG_FILE}" | while IFS='|' read -r scenario operation payload_size iterations warmup_iterations; do
  raw_file="${RAW_DIR}/${scenario}.txt"
  setup_raw_file="${RESULT_DIR}/${scenario}.setup.txt"
  before_file="${RESULT_DIR}/${scenario}.before_setup_cycles.txt"
  after_setup_file="${RESULT_DIR}/${scenario}.after_setup_cycles.txt"
  after_measure_file="${RESULT_DIR}/${scenario}.after_measure_cycles.txt"
  stderr_file="${RESULT_DIR}/${scenario}.stderr.txt"
  prefix="/Wiki/bench/deployed/${RUN_TIMESTAMP}/latency/${scenario}"
  bench_log "canister latency ${scenario}"
  capture_canister_cycles_json "${CANISTER_ID}" "${before_file}"
  "${BENCH_BIN}" latency-setup \
    --output-json "${setup_raw_file}" \
    --benchmark-name "${scenario}" \
    "${LOCAL_ARGS[@]}" \
    --canister-id "${CANISTER_ID}" \
    --database-id "${DATABASE_ID}" \
    --prefix "${prefix}" \
    --payload-size-bytes "${payload_size}" \
    --operation "${operation}" >/dev/null
  capture_canister_cycles_json "${CANISTER_ID}" "${after_setup_file}"
  if "${BENCH_BIN}" latency-measure \
    --output-json "${raw_file}" \
    --benchmark-name "${scenario}" \
    "${LOCAL_ARGS[@]}" \
    --canister-id "${CANISTER_ID}" \
    --database-id "${DATABASE_ID}" \
    --prefix "${prefix}" \
    --payload-size-bytes "${payload_size}" \
    --iterations "${iterations}" \
    --operation "${operation}" 2> "${stderr_file}"; then
    :
  else
    error_text="$(tr '\n' ' ' < "${stderr_file}" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
    if [[ -z "${error_text}" ]]; then
      error_text="benchmark command failed"
    fi
    write_failed_raw "${raw_file}" "${scenario}" "${operation}" "${payload_size}" "${iterations}" "${warmup_iterations}" "${error_text}"
  fi
  capture_canister_cycles_json "${CANISTER_ID}" "${after_measure_file}"
  augment_raw_with_isolated_cycles "${raw_file}" "${setup_raw_file}" "${before_file}" "${after_setup_file}" "${after_measure_file}" "${iterations}"
  append_summary "${raw_file}"
done

bench_log "canister VFS latency results saved to ${RESULT_DIR}"
printf 'summary=%s\n' "${SUMMARY_FILE}"
