#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/bench/run_beam_grounded_slice.sh
# What: Prepare then run one grounded QA slice against the read-only BEAM eval harness.
# Why: Test runs should use one command so prepare/eval order is never skipped.

if [[ $# -lt 5 ]]; then
  echo "usage: $0 <slice> <canister-id> <dataset-path> <output-dir> <namespace> [extra args...]" >&2
  exit 1
fi

SLICE="$1"
CANISTER_ID="$2"
DATASET_PATH="$3"
OUTPUT_DIR="$4"
NAMESPACE="$5"
shift 5

SPLIT="100K"
LIMIT_ARGS=()
PASSTHROUGH_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --split)
      SPLIT="$2"
      PASSTHROUGH_ARGS+=("$1" "$2")
      shift 2
      ;;
    --limit)
      LIMIT_ARGS=("$1" "$2")
      PASSTHROUGH_ARGS+=("$1" "$2")
      shift 2
      ;;
    *)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
  esac
done

ARGS=(
  --local
  --canister-id "$CANISTER_ID"
  --dataset-path "$DATASET_PATH"
  --split "$SPLIT"
  --output-dir "$OUTPUT_DIR"
  --eval-mode retrieve-and-extract
  --top-k 3
  --parallelism 1
  --namespace "$NAMESPACE"
)

case "$SLICE" in
  information-extraction)
    ARGS+=(--include-question-type information_extraction)
    ;;
  temporal-reasoning)
    ARGS+=(--include-question-type temporal_reasoning)
    ;;
  event-ordering)
    ARGS+=(--include-question-type event_ordering)
    ;;
  instruction-following)
    ARGS+=(--include-question-type instruction_following)
    ;;
  preference-following)
    ARGS+=(--include-question-type preference_following)
    ;;
  knowledge-update)
    ARGS+=(--include-question-type knowledge_update)
    ;;
  contradiction-resolution)
    ARGS+=(--include-question-type contradiction_resolution)
    ;;
  summarization)
    ARGS+=(--include-question-type summarization)
    ;;
  multi-session-reasoning)
    ARGS+=(--include-question-type multi_session_reasoning)
    ;;
  abstention)
    ARGS+=(--include-question-type abstention)
    ;;
  facts)
    ARGS+=(--include-question-type information_extraction)
    ;;
  temporal)
    ARGS+=(--include-question-type temporal_reasoning)
    ;;
  plan)
    ARGS+=(--include-question-class factoid --include-tag plan)
    ;;
  *)
    echo "unknown slice: $SLICE" >&2
    exit 1
    ;;
esac

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
bash "${BENCH_DIR}/run_beam_prepare.sh" \
  --local \
  --canister-id "$CANISTER_ID" \
  --dataset-path "$DATASET_PATH" \
  --split "$SPLIT" \
  --namespace "$NAMESPACE" \
  "${LIMIT_ARGS[@]}"
bash "${BENCH_DIR}/run_beam_bench.sh" "${ARGS[@]}" "${PASSTHROUGH_ARGS[@]}"
