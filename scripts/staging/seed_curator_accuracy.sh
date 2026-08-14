#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/staging/seed_curator_accuracy.sh
# What: Generate, safely seed, resume, and verify the fixed Curator staging accuracy corpus.
# Why: Accuracy data must never overwrite existing staging wiki nodes or look complete after a partial batch failure.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE_ID=""
SEED_ID="curator-accuracy-v1"
CANISTER_ID="3ryrw-kyaaa-aaaaf-qgxpq-cai"
CONFIRM=0
REPAIR=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-id)
      DATABASE_ID="${2:-}"
      shift 2
      ;;
    --seed-id)
      SEED_ID="${2:-}"
      shift 2
      ;;
    --confirm)
      CONFIRM=1
      shift
      ;;
    --repair)
      REPAIR=1
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if ! [[ "${DATABASE_ID}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "--database-id is required and must be a canonical database id" >&2
  exit 1
fi

if ! [[ "${SEED_ID}" =~ ^[a-z0-9-]{1,48}$ ]]; then
  echo "--seed-id must use 1..48 lowercase letters, digits, or hyphens" >&2
  exit 1
fi

cd "${REPO_ROOT}"
cargo build -p kinic-vfs-cli --bin kinic-vfs-cli --bin curator_accuracy_eval --locked

CLI_BIN="${REPO_ROOT}/target/debug/kinic-vfs-cli"
EVAL_BIN="${REPO_ROOT}/target/debug/curator_accuracy_eval"
RESULT_DIR="${REPO_ROOT}/.benchmarks/results/curator_accuracy/staging/${DATABASE_ID}/${SEED_ID}"
DEFINITION_DIR="${RESULT_DIR}/definition"
MANIFEST="${DEFINITION_DIR}/seed-manifest.json"
SCAN="${RESULT_DIR}/scan.curator-scan.json"
PREFLIGHT="${RESULT_DIR}/preflight.seed-report.json"
FINAL_REPORT="${RESULT_DIR}/final.seed-report.json"
REPAIR_DIR="${RESULT_DIR}/repair"

mkdir -p "${RESULT_DIR}"
if [[ ! -f "${MANIFEST}" ]]; then
  "${EVAL_BIN}" seed --out-dir "${DEFINITION_DIR}" --seed-id "${SEED_ID}"
elif [[ "${REPAIR}" == "1" ]]; then
  "${EVAL_BIN}" seed --out-dir "${DEFINITION_DIR}" --seed-id "${SEED_ID}" --overwrite
fi

"${EVAL_BIN}" validate-seed-definition \
  --manifest "${MANIFEST}" \
  --definition-dir "${DEFINITION_DIR}"

CLI_ARGS=(
  --allow-non-ii-identity
  --identity-mode identity
  --canister-id "${CANISTER_ID}"
  --database-id "${DATABASE_ID}"
)

"${CLI_BIN}" "${CLI_ARGS[@]}" curator scan --out "${SCAN}" --overwrite --json
"${EVAL_BIN}" verify-seed \
  --scan "${SCAN}" \
  --manifest "${MANIFEST}" \
  --out "${PREFLIGHT}" \
  --allow-partial \
  --overwrite

node -e '
const fs = require("fs");
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const repair = process.argv[2] === "1";
if ((!repair && report.content_mismatches.length) || report.unexpected_paths.length || report.batch_statuses.some((batch) => batch.status === "partial")) {
  console.error(JSON.stringify({content_mismatches: report.content_mismatches, unexpected_paths: report.unexpected_paths, batch_statuses: report.batch_statuses}, null, 2));
  process.exit(1);
}
' "${PREFLIGHT}" "${REPAIR}"

node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const status = new Map(report.batch_statuses.map((batch) => [batch.index, batch.status]));
for (const batch of manifest.batches) console.log(`${batch.index}\t${status.get(batch.index)}\t${batch.file}\t${batch.node_count}`);
' "${MANIFEST}" "${PREFLIGHT}"

if [[ "${REPAIR}" == "1" ]]; then
  node -e '
const fs = require("fs");
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (report.batch_statuses.some((batch) => batch.status !== "complete")) {
  console.error("--repair requires every seed batch to be complete");
  process.exit(1);
}
' "${PREFLIGHT}"
  mkdir -p "${REPAIR_DIR}"
  while read -r index; do
    "${EVAL_BIN}" repair-seed \
      --scan "${SCAN}" \
      --manifest "${MANIFEST}" \
      --definition-dir "${DEFINITION_DIR}" \
      --out "${REPAIR_DIR}/batch-${index}.json" \
      --batch-index "${index}" \
      --overwrite
  done < <(node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const batch of manifest.batches) console.log(batch.index);
' "${MANIFEST}")
fi

if [[ "${CONFIRM}" != "1" ]]; then
  echo "dry-run only; no seed nodes written. Rerun with --confirm after reviewing ${MANIFEST}" >&2
  exit 0
fi

while IFS=$'\t' read -r index status file node_count; do
  if [[ "${status}" == "complete" ]]; then
    echo "seed batch ${index} already complete; skipping" >&2
    continue
  fi
  if [[ "${status}" != "missing" ]]; then
    echo "seed batch ${index} has unsafe status ${status}; refusing" >&2
    exit 1
  fi
  echo "writing seed batch ${index} (${node_count} nodes)" >&2
  "${EVAL_BIN}" validate-seed-batch \
    --manifest "${MANIFEST}" \
    --input "${DEFINITION_DIR}/${file}" \
    --batch-index "${index}" \
    --mode initial
  "${CLI_BIN}" "${CLI_ARGS[@]}" write-nodes --input "${DEFINITION_DIR}/${file}" --json
done < <(node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const status = new Map(report.batch_statuses.map((batch) => [batch.index, batch.status]));
for (const batch of manifest.batches) console.log(`${batch.index}\t${status.get(batch.index)}\t${batch.file}\t${batch.node_count}`);
' "${MANIFEST}" "${PREFLIGHT}")

if [[ "${REPAIR}" == "1" ]]; then
  while read -r index; do
    REPAIR_BATCH="${REPAIR_DIR}/batch-${index}.json"
    REPAIR_COUNT="$(node -e '
const fs = require("fs");
console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).length);
' "${REPAIR_BATCH}")"
    if [[ "${REPAIR_COUNT}" != "0" ]]; then
      echo "repairing ${REPAIR_COUNT} seed nodes from ordered batch ${index} with etag guards" >&2
      "${EVAL_BIN}" validate-seed-batch \
        --manifest "${MANIFEST}" \
        --input "${REPAIR_BATCH}" \
        --batch-index "${index}" \
        --mode repair \
        --scan "${SCAN}"
      "${CLI_BIN}" "${CLI_ARGS[@]}" write-nodes --input "${REPAIR_BATCH}" --json
    fi
  done < <(node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const batch of manifest.batches) console.log(batch.index);
' "${MANIFEST}")
fi

"${CLI_BIN}" "${CLI_ARGS[@]}" curator scan --out "${SCAN}" --overwrite --json
"${EVAL_BIN}" verify-seed \
  --scan "${SCAN}" \
  --manifest "${MANIFEST}" \
  --out "${FINAL_REPORT}" \
  --overwrite

echo "Curator staging accuracy seed is complete: ${FINAL_REPORT}" >&2
