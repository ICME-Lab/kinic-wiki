#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/bench/run_canister_vfs_workload.sh
# What: Run API-centric repeated-request benchmarks against a deployed canister.
# Why: We want operation-level cycle, latency, and wire-IO costs for the real canister API.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

require_command "cargo" "Rust toolchain is required to build the vfs_bench client binary."
require_command "node" "Node.js is required to materialize JSON summaries."
require_command "icp" "The icp CLI is required to collect canister cycle costs."

REPLICA_HOST="${REPLICA_HOST:-}"
CANISTER_ID="${CANISTER_ID:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --replica-host) REPLICA_HOST="$2"; shift 2 ;;
    --canister-id) CANISTER_ID="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "${REPLICA_HOST}" || -z "${CANISTER_ID}" ]]; then
  echo "usage: REPLICA_HOST=... CANISTER_ID=... bash scripts/bench/run_canister_vfs_workload.sh" >&2
  exit 1
fi

RESULT_DIR="$(bench_results_dir "canister_vfs_workload")"
RAW_DIR="$(bench_raw_dir "${RESULT_DIR}")"
SUMMARY_FILE="${RESULT_DIR}/summary.txt"
CONFIG_FILE="${RESULT_DIR}/config.txt"
ENVIRONMENT_FILE="${RESULT_DIR}/environment.txt"
write_summary_header "${SUMMARY_FILE}" "canister_vfs_workload"
write_environment_json "${ENVIRONMENT_FILE}"
augment_environment_json "${ENVIRONMENT_FILE}" "${REPLICA_HOST}" "${CANISTER_ID}" "ic-agent" "icp" "true"

bench_log "building vfs_bench binary"
cd "$(bench_repo_root)"
cargo build -p wiki-cli --bin vfs_bench >/dev/null
BENCH_BIN="$(bench_vfs_bench_bin)"

node -e '
  const fs = require("fs");
  const [configFile, replicaHost, canisterId] = process.argv.slice(1);
  const parseList = (value, fallback) => !value ? fallback : value.split(",").map(item => item.trim()).filter(Boolean);
  const diagnosticProfile = process.env.WIKI_CANISTER_DIAGNOSTIC_PROFILE || "baseline";
  const replicaResetMode = process.env.BENCH_REPLICA_RESET_MODE || null;
  const sizeSpecs = [
    { label: "1k", bytes: 1024, iterations: Number(process.env.WORKLOAD_ITERATIONS_1K || 200) },
    { label: "10k", bytes: 10240, iterations: Number(process.env.WORKLOAD_ITERATIONS_10K || 100) },
    { label: "100k", bytes: 102400, iterations: Number(process.env.WORKLOAD_ITERATIONS_100K || 40) },
    { label: "1mb", bytes: 1048576, iterations: Number(process.env.WORKLOAD_ITERATIONS_1MB || 10) }
  ];
  const pickIterations = (operation, size) => {
    if (operation === "list") return Number(process.env.WORKLOAD_LIST_ITERATIONS || 100);
    if (operation === "search") return Number(process.env.WORKLOAD_SEARCH_ITERATIONS || 50);
    if (operation === "mkdir" || operation === "glob" || operation === "recent") {
      return Number(process.env.WORKLOAD_QUERY_ITERATIONS || process.env.WORKLOAD_LIST_ITERATIONS || 100);
    }
    return size.iterations;
  };
  const defaultOperations = [
    "create", "update", "append", "edit", "move_same_dir", "move_cross_dir", "delete", "read", "list", "search",
    "mkdir", "glob", "recent", "multi_edit"
  ];
  if (!process.env.WORKLOAD_OPERATIONS && diagnosticProfile === "fts_disabled_for_bench") {
    const searchIndex = defaultOperations.indexOf("search");
    if (searchIndex >= 0) {
      defaultOperations.splice(searchIndex, 1);
    }
  }
  const operations = parseList(process.env.WORKLOAD_OPERATIONS, defaultOperations);
  const directoryShapes = parseList(process.env.WORKLOAD_DIRECTORY_SHAPES, ["flat"]);
  const fileCount = Number(process.env.WORKLOAD_FILE_COUNT || 100);
  const clients = Number(process.env.WORKLOAD_CONCURRENT_CLIENTS || 1);
  const scenarios = [];
  for (const operation of operations) for (const shape of directoryShapes)
      for (const size of sizeSpecs) {
        const iterations = pickIterations(operation, size);
        if (iterations <= 0) continue;
        // `mkdir` is the only workload scenario that stays scenario_total.
        // Everything else should report pure measured-request cycles first.
        const measurementMode = operation === "mkdir"
          ? "scenario_total"
          : "isolated_single_op";
        scenarios.push({
          scenario: `${operation}_${shape}_n${fileCount}_p${size.bytes}_c${clients}`,
          operation,
          measurement_mode: measurementMode,
          directory_shape: shape,
          file_count: fileCount,
          payload_size_bytes: size.bytes,
          concurrent_clients: clients,
          iterations,
          warmup_iterations: 0
        });
      }
  const payload = {
    tool: "canister_vfs_workload",
    replica_host: replicaHost,
    canister_id: canisterId,
    benchmark_transport: "ic-agent",
    diagnostic_profile: diagnosticProfile,
    replica_reset_mode: replicaResetMode,
    operations,
    directory_shapes: directoryShapes,
    file_count: fileCount,
    payload_sizes: sizeSpecs,
    concurrent_clients: clients,
    scenarios
  };
  fs.writeFileSync(configFile, JSON.stringify(payload, null, 2) + "\n");
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
      `openai_tool=${data.openai_tool ?? null}`,
      `openai_tool_variant=${data.openai_tool_variant ?? null}`,
      `directory_shape=${data.directory_shape}`,
      `file_count=${data.file_count}`,
      `payload_size_bytes=${data.payload_size_bytes}`,
      `concurrent_clients=${data.concurrent_clients}`,
      `iterations=${data.iterations}`,
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
    ];
    if (data.measurement_mode === "isolated_single_op") {
      lines.push(
        `setup_cycles_delta=${data.setup_cycles_delta}`,
        `measured_cycles_delta=${data.measured_cycles_delta}`,
        `cycles_per_measured_request=${data.cycles_per_measured_request}`
      );
    } else {
      lines.push(
        `cycles_delta=${data.cycles_delta}`,
        `cycles_per_request=${data.cycles_per_request}`
      );
    }
    lines.push(
      `cycles_error=${data.cycles_error}`,
      `cycles_source=${data.cycles_source ?? null}`,
      `cycles_scope=${data.cycles_scope ?? null}`,
      `raw_file=${rawFile}`,
      ""
    );
    console.log(lines.join("\n"));
  ' "${raw_file}" >> "${SUMMARY_FILE}"
}

write_failed_raw() {
  local raw_file="$1"
  local scenario="$2"
  local operation="$3"
  local directory_shape="$4"
  local file_count="$5"
  local payload_size="$6"
  local concurrent_clients="$7"
  local iterations="$8"
  local measurement_mode="$9"
  local error_text="${10}"
  node -e '
    const fs = require("fs");
    const [
      rawFile,
      scenario,
      operation,
      directoryShape,
      fileCount,
      payloadSize,
      concurrentClients,
      iterations,
      measurementMode,
      errorText
    ] = process.argv.slice(1);
    const op = operation.replaceAll("-", "_");
    const openaiMap = {
      create: { openai_tool: "write", openai_tool_variant: "create" },
      update: { openai_tool: "write", openai_tool_variant: "overwrite" },
      append: { openai_tool: "append", openai_tool_variant: null },
      edit: { openai_tool: "edit", openai_tool_variant: null },
      move_same_dir: { openai_tool: "mv", openai_tool_variant: "same_dir" },
      move_cross_dir: { openai_tool: "mv", openai_tool_variant: "cross_dir" },
      delete: { openai_tool: "rm", openai_tool_variant: null },
      read: { openai_tool: "read", openai_tool_variant: null },
      list: { openai_tool: "ls", openai_tool_variant: null },
      search: { openai_tool: "search", openai_tool_variant: null },
      mkdir: { openai_tool: "mkdir", openai_tool_variant: null },
      glob: { openai_tool: "glob", openai_tool_variant: null },
      recent: { openai_tool: "recent", openai_tool_variant: null },
      multi_edit: { openai_tool: "multi_edit", openai_tool_variant: null }
    };
    const oa = openaiMap[op] ?? { openai_tool: op, openai_tool_variant: null };
    fs.writeFileSync(rawFile, JSON.stringify({
      benchmark_name: scenario,
      operation: op,
      openai_tool: oa.openai_tool,
      openai_tool_variant: oa.openai_tool_variant,
      directory_shape: directoryShape,
      measurement_mode: measurementMode,
      file_count: Number(fileCount),
      payload_size_bytes: Number(payloadSize),
      concurrent_clients: Number(concurrentClients),
      iterations: Number(iterations),
      warmup_iterations: 0,
      setup_request_count: null,
      measured_request_count: null,
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
      cycles_delta: null,
      setup_cycles_delta: null,
      measured_cycles_delta: null,
      cycles_per_request: null,
      cycles_per_measured_request: null,
      error: errorText
    }, null, 2) + "\n");
  ' "${raw_file}" "${scenario}" "${operation}" "${directory_shape}" "${file_count}" "${payload_size}" "${concurrent_clients}" "${iterations}" "${measurement_mode}" "${error_text}"
}

node -e '
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const scenario of data.scenarios) {
    console.log([
      scenario.scenario,
      scenario.operation,
      scenario.measurement_mode,
      scenario.directory_shape,
      scenario.file_count,
      scenario.payload_size_bytes,
      scenario.concurrent_clients,
      scenario.iterations,
      scenario.warmup_iterations
    ].join("|"));
  }
' "${CONFIG_FILE}" | while IFS='|' read -r scenario operation measurement_mode directory_shape file_count payload_size concurrent_clients iterations warmup_iterations; do
  raw_file="${RAW_DIR}/${scenario}.txt"
  before_file="${RESULT_DIR}/${scenario}.before_cycles.txt"
  after_file="${RESULT_DIR}/${scenario}.after_cycles.txt"
  stderr_file="${RESULT_DIR}/${scenario}.stderr.txt"
  prefix="/Wiki/bench/deployed/${RUN_TIMESTAMP}/workload/${scenario}"
  cli_operation="${operation//_/-}"
  bench_log "canister workload ${scenario}"
  if [[ "${measurement_mode}" == "isolated_single_op" ]]; then
    setup_raw_file="${RESULT_DIR}/${scenario}.setup.txt"
    after_setup_file="${RESULT_DIR}/${scenario}.after_setup_cycles.txt"
    capture_canister_cycles_json "${CANISTER_ID}" "${before_file}"
    if "${BENCH_BIN}" workload-setup \
      --output-json "${setup_raw_file}" \
      --benchmark-name "${scenario}" \
      --replica-host "${REPLICA_HOST}" \
      --canister-id "${CANISTER_ID}" \
      --prefix "${prefix}" \
      --payload-size-bytes "${payload_size}" \
      --file-count "${file_count}" \
      --directory-shape "${directory_shape}" \
      --concurrent-clients "${concurrent_clients}" \
      --iterations "${iterations}" \
      --operation "${cli_operation}" 2> "${stderr_file}"; then
      :
    else
      error_text="$(tr '\n' ' ' < "${stderr_file}" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
      [[ -n "${error_text}" ]] || error_text="benchmark setup command failed"
      write_failed_raw "${raw_file}" "${scenario}" "${cli_operation}" "${directory_shape}" "${file_count}" "${payload_size}" "${concurrent_clients}" "${iterations}" "${measurement_mode}" "${error_text}"
      capture_canister_cycles_json "${CANISTER_ID}" "${after_file}"
      augment_raw_with_cycles "${raw_file}" "${before_file}" "${after_file}" "${iterations}"
      append_summary "${raw_file}"
      continue
    fi
    capture_canister_cycles_json "${CANISTER_ID}" "${after_setup_file}"
    if "${BENCH_BIN}" workload-measure \
      --output-json "${raw_file}" \
      --benchmark-name "${scenario}" \
      --replica-host "${REPLICA_HOST}" \
      --canister-id "${CANISTER_ID}" \
      --prefix "${prefix}" \
      --payload-size-bytes "${payload_size}" \
      --file-count "${file_count}" \
      --directory-shape "${directory_shape}" \
      --concurrent-clients "${concurrent_clients}" \
      --iterations "${iterations}" \
      --operation "${cli_operation}" 2> "${stderr_file}"; then
      :
    else
      error_text="$(tr '\n' ' ' < "${stderr_file}" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
      [[ -n "${error_text}" ]] || error_text="benchmark command failed"
      write_failed_raw "${raw_file}" "${scenario}" "${cli_operation}" "${directory_shape}" "${file_count}" "${payload_size}" "${concurrent_clients}" "${iterations}" "${measurement_mode}" "${error_text}"
    fi
    capture_canister_cycles_json "${CANISTER_ID}" "${after_file}"
    augment_raw_with_isolated_cycles "${raw_file}" "${setup_raw_file}" "${before_file}" "${after_setup_file}" "${after_file}" "${iterations}"
    append_summary "${raw_file}"
    continue
  fi
  capture_canister_cycles_json "${CANISTER_ID}" "${before_file}"
  if "${BENCH_BIN}" workload \
    --output-json "${raw_file}" \
    --benchmark-name "${scenario}" \
    --replica-host "${REPLICA_HOST}" \
    --canister-id "${CANISTER_ID}" \
    --prefix "${prefix}" \
    --payload-size-bytes "${payload_size}" \
    --file-count "${file_count}" \
    --directory-shape "${directory_shape}" \
    --concurrent-clients "${concurrent_clients}" \
    --iterations "${iterations}" \
    --warmup-iterations "${warmup_iterations}" \
    --operation "${cli_operation}" 2> "${stderr_file}"; then
    :
  else
    error_text="$(tr '\n' ' ' < "${stderr_file}" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
    if [[ -z "${error_text}" ]]; then
      error_text="benchmark command failed"
    fi
    write_failed_raw "${raw_file}" "${scenario}" "${cli_operation}" "${directory_shape}" "${file_count}" "${payload_size}" "${concurrent_clients}" "${iterations}" "${measurement_mode}" "${error_text}"
  fi
  capture_canister_cycles_json "${CANISTER_ID}" "${after_file}"
  augment_raw_with_cycles "${raw_file}" "${before_file}" "${after_file}" "${iterations}"
  append_summary "${raw_file}"
done

bench_log "canister VFS workload results saved to ${RESULT_DIR}"
printf 'summary=%s\n' "${SUMMARY_FILE}"
