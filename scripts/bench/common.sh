#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/bench/common.sh
# What: Shared helpers for deployed canister benchmark wrappers.
# Why: The workload, latency, and fresh-compare runners should resolve paths and emit artifacts the same way.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BENCH_ROOT="${REPO_ROOT}/.benchmarks"
RESULTS_ROOT="${BENCH_ROOT}/results"
RUN_TIMESTAMP="${RUN_TIMESTAMP_OVERRIDE:-$(date -u +%Y%m%dT%H%M%SZ)}"

bench_repo_root() {
  printf '%s\n' "${REPO_ROOT}"
}

# Matches where `cargo build` writes when run from the workspace root (honors CARGO_TARGET_DIR).
bench_cargo_target_root() {
  printf '%s\n' "${CARGO_TARGET_DIR:-${REPO_ROOT}/target}"
}

bench_vfs_bench_bin() {
  printf '%s/debug/vfs_bench\n' "$(bench_cargo_target_root)"
}

bench_results_dir() {
  local tool="$1"
  local dir="${RESULTS_ROOT}/${tool}/${RUN_TIMESTAMP}"
  mkdir -p "${dir}"
  printf '%s\n' "${dir}"
}

bench_raw_dir() {
  local result_dir="$1"
  local dir="${result_dir}/raw"
  mkdir -p "${dir}"
  printf '%s\n' "${dir}"
}

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "missing required command: ${command_name}" >&2
    echo "${install_hint}" >&2
    exit 1
  fi
}

bench_log() {
  printf '[bench] %s\n' "$*"
}

write_summary_header() {
  local file="$1"
  local tool="$2"
  local generated_at_utc
  generated_at_utc="$(date -u +"%Y-%m-%d %H:%M:%S UTC")"
  {
    printf 'tool=%s\n' "${tool}"
    printf 'timestamp=%s\n' "${RUN_TIMESTAMP}"
    printf 'generated_at_utc=%s\n' "${generated_at_utc}"
    printf 'repo_root=%s\n' "${REPO_ROOT}"
  } > "${file}"
}

write_environment_json() {
  local file="$1"
  local os_name
  local kernel_version
  local cpu_name=""
  local memory_bytes=""
  local rust_version=""
  local node_version=""

  os_name="$(uname -s)"
  kernel_version="$(uname -r)"

  if [[ "${os_name}" == "Darwin" ]]; then
    cpu_name="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"
    memory_bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
  else
    cpu_name="$(lscpu 2>/dev/null | awk -F: '/Model name/ { gsub(/^[ \t]+/, "", $2); print $2; exit }')"
    memory_bytes="$(awk '/MemTotal:/ { print $2 * 1024; exit }' /proc/meminfo 2>/dev/null || true)"
  fi

  if [[ -z "${cpu_name}" ]]; then
    cpu_name="$(uname -m)"
  fi

  if command -v rustc >/dev/null 2>&1; then
    rust_version="$(rustc --version 2>/dev/null || true)"
  fi
  if command -v node >/dev/null 2>&1; then
    node_version="$(node --version 2>/dev/null || true)"
  fi

  node -e '
    const fs = require("fs");
    const [
      outputFile,
      osName,
      kernelVersion,
      cpuName,
      memoryBytes,
      rustVersion,
      nodeVersion
    ] = process.argv.slice(1);
    const asNullableString = value => value === "" ? null : value;
    const parsedMemory = memoryBytes === "" ? null : Number(memoryBytes);
    const payload = {
      os: osName,
      kernel_version: kernelVersion,
      cpu: asNullableString(cpuName),
      memory_bytes: Number.isFinite(parsedMemory) ? parsedMemory : null,
      rust_version: asNullableString(rustVersion),
      node_version: asNullableString(nodeVersion)
    };
    fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2) + "\n");
  ' \
    "${file}" \
    "${os_name}" \
    "${kernel_version}" \
    "${cpu_name}" \
    "${memory_bytes}" \
    "${rust_version}" \
    "${node_version}"
}

augment_environment_json() {
  local file="$1"
  local replica_host="$2"
  local canister_id="$3"
  local bench_transport="$4"
  local canister_status_source="${5:-icp}"
  local cycles_collection_enabled="${6:-true}"
  local replica_reset_mode="${BENCH_REPLICA_RESET_MODE:-}"
  local diagnostic_profile="${WIKI_CANISTER_DIAGNOSTIC_PROFILE:-baseline}"

  node -e '
    const fs = require("fs");
    const [
      filePath,
      replicaHost,
      canisterId,
      benchTransport,
      canisterStatusSource,
      cyclesCollectionEnabled,
      replicaResetMode,
      diagnosticProfile
    ] = process.argv.slice(1);
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    payload.replica_host = replicaHost;
    payload.canister_id = canisterId;
    payload.bench_transport = benchTransport;
    payload.canister_status_source = canisterStatusSource;
    payload.cycles_collection_enabled = cyclesCollectionEnabled === "true";
    payload.replica_reset_mode = replicaResetMode === "" ? null : replicaResetMode;
    payload.diagnostic_profile = diagnosticProfile === "" ? null : diagnosticProfile;
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n");
  ' "${file}" "${replica_host}" "${canister_id}" "${bench_transport}" "${canister_status_source}" "${cycles_collection_enabled}" "${replica_reset_mode}" "${diagnostic_profile}"
}

capture_canister_cycles_json() {
  local canister_id="$1"
  local output_file="$2"
  local environment="${CANISTER_STATUS_ENVIRONMENT:-local}"
  local network="${CANISTER_STATUS_NETWORK:-}"
  local status_output=""
  local status_error=""
  local -a cmd=(icp canister status --json)

  if [[ -n "${network}" ]]; then
    cmd+=(-n "${network}")
  else
    cmd+=(-e "${environment}")
  fi
  cmd+=("${canister_id}")

  if status_output="$("${cmd[@]}" 2>&1)"; then
    node -e '
      const fs = require("fs");
      const [outputFile, raw] = process.argv.slice(1);
      const parsed = JSON.parse(raw);
      const cycles = typeof parsed.cycles === "string" ? parsed.cycles.replaceAll("_", "") : null;
      fs.writeFileSync(outputFile, JSON.stringify({
        value: cycles,
        error: null,
        source: "icp_canister_status_json"
      }, null, 2) + "\n");
    ' "${output_file}" "${status_output}"
  else
    status_error="${status_output}"
    node -e '
      const fs = require("fs");
      const [outputFile, errorText] = process.argv.slice(1);
      fs.writeFileSync(outputFile, JSON.stringify({
        value: null,
        error: errorText,
        source: "icp_canister_status_json"
      }, null, 2) + "\n");
    ' "${output_file}" "${status_error}"
  fi
}

augment_raw_with_cycles() {
  local raw_file="$1"
  local before_file="$2"
  local after_file="$3"
  local fallback_request_count="$4"

  node -e '
    const fs = require("fs");
    const [rawFile, beforeFile, afterFile, fallbackRequestCountText] = process.argv.slice(1);
    const raw = JSON.parse(fs.readFileSync(rawFile, "utf8"));
    const before = JSON.parse(fs.readFileSync(beforeFile, "utf8"));
    const after = JSON.parse(fs.readFileSync(afterFile, "utf8"));
    const fallbackRequestCount = Number(fallbackRequestCountText);
    const rawRequestCount = Number(raw.request_count);
    const requestCount = Number.isFinite(rawRequestCount) && rawRequestCount > 0
      ? rawRequestCount
      : fallbackRequestCount;
    let delta = null;
    let perRequest = null;
    if (before.value !== null && after.value !== null) {
      const beforeValue = BigInt(before.value);
      const afterValue = BigInt(after.value);
      delta = (beforeValue - afterValue).toString();
      if (requestCount > 0) {
        perRequest = (BigInt(delta) / BigInt(requestCount)).toString();
      }
    }
    raw.cycles_before = before.value;
    raw.cycles_after = after.value;
    raw.cycles_delta = delta;
    raw.cycles_per_request = perRequest;
    raw.cycles_per_measured_request = perRequest;
    raw.cycles_error = before.error ?? after.error;
    raw.cycles_source = after.source ?? before.source;
    raw.cycles_scope = "scenario_total";
    raw.measurement_mode = raw.measurement_mode ?? "scenario_total";
    raw.setup_request_count = 0;
    raw.measured_request_count = requestCount;
    raw.setup_cycles_before = null;
    raw.setup_cycles_after = null;
    raw.setup_cycles_delta = null;
    raw.measured_cycles_before = before.value;
    raw.measured_cycles_after = after.value;
    raw.measured_cycles_delta = delta;
    fs.writeFileSync(rawFile, JSON.stringify(raw, null, 2) + "\n");
  ' "${raw_file}" "${before_file}" "${after_file}" "${fallback_request_count}"
}

augment_raw_with_isolated_cycles() {
  local raw_file="$1"
  local setup_raw_file="$2"
  local before_setup_file="$3"
  local after_setup_file="$4"
  local after_measure_file="$5"
  local fallback_measured_request_count="$6"

  node -e '
    const fs = require("fs");
    const [rawFile, setupRawFile, beforeSetupFile, afterSetupFile, afterMeasureFile, fallbackMeasuredText] = process.argv.slice(1);
    const raw = JSON.parse(fs.readFileSync(rawFile, "utf8"));
    const setup = JSON.parse(fs.readFileSync(setupRawFile, "utf8"));
    const beforeSetup = JSON.parse(fs.readFileSync(beforeSetupFile, "utf8"));
    const afterSetup = JSON.parse(fs.readFileSync(afterSetupFile, "utf8"));
    const afterMeasure = JSON.parse(fs.readFileSync(afterMeasureFile, "utf8"));
    const fallbackMeasured = Number(fallbackMeasuredText);
    const measuredCount = Number.isFinite(Number(raw.request_count)) && Number(raw.request_count) > 0
      ? Number(raw.request_count)
      : fallbackMeasured;
    const setupCount = Number.isFinite(Number(setup.request_count)) ? Number(setup.request_count) : 0;
    const delta = (left, right) => {
      if (left.value === null || right.value === null) return null;
      return (BigInt(left.value) - BigInt(right.value)).toString();
    };
    const setupDelta = delta(beforeSetup, afterSetup);
    const measuredDelta = delta(afterSetup, afterMeasure);
    const totalDelta = delta(beforeSetup, afterMeasure);
    let perMeasured = null;
    if (measuredDelta !== null && measuredCount > 0) {
      perMeasured = (BigInt(measuredDelta) / BigInt(measuredCount)).toString();
    }
    raw.measurement_mode = "isolated_single_op";
    raw.setup_request_count = setupCount;
    raw.measured_request_count = measuredCount;
    raw.cycles_before = beforeSetup.value;
    raw.cycles_after = afterMeasure.value;
    raw.cycles_delta = totalDelta;
    raw.cycles_per_request = perMeasured;
    raw.cycles_per_measured_request = perMeasured;
    raw.cycles_error = beforeSetup.error ?? afterSetup.error ?? afterMeasure.error;
    raw.cycles_source = afterMeasure.source ?? afterSetup.source ?? beforeSetup.source;
    raw.cycles_scope = "isolated_single_op";
    raw.setup_cycles_before = beforeSetup.value;
    raw.setup_cycles_after = afterSetup.value;
    raw.setup_cycles_delta = setupDelta;
    raw.measured_cycles_before = afterSetup.value;
    raw.measured_cycles_after = afterMeasure.value;
    raw.measured_cycles_delta = measuredDelta;
    fs.writeFileSync(rawFile, JSON.stringify(raw, null, 2) + "\n");
  ' "${raw_file}" "${setup_raw_file}" "${before_setup_file}" "${after_setup_file}" "${after_measure_file}" "${fallback_measured_request_count}"
}
