#!/usr/bin/env bash
# where: llm-wiki local audit helper
# what: run SPECA against this repository through the local Codex CLI runtime
# why: Codex tool policy blocks this chat from launching the external-send audit directly
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
speca_src="${SPECA_SRC:-/Volumes/KINGSTON/speca/speca-src}"
output_dir="${SPECA_OUTPUT_DIR:-${repo_root}/outputs}"
archive_root="${SPECA_ARCHIVE_ROOT:-${repo_root}/.speca/runs}"
target_phase="${SPECA_TARGET_PHASE:-04}"
workers="${SPECA_WORKERS:-2}"
max_concurrent="${SPECA_MAX_CONCURRENT:-2}"
codex_model="${CODEX_MODEL:-gpt-5.5}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/run_speca_codex.sh [--yes] [--force]

Environment overrides:
  SPECA_SRC=/path/to/speca-src
  SPECA_TARGET_PHASE=04
  SPECA_WORKERS=2
  SPECA_MAX_CONCURRENT=2
  CODEX_MODEL=gpt-5.5

Notes:
  This sends repository content, including uncommitted changes, to the Codex
  external service through `codex exec --json`.
USAGE
}

confirm_external_send=1
force_flag=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y)
      confirm_external_send=0
      ;;
    --force)
      force_flag=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$speca_src" ]]; then
  echo "speca source not found: $speca_src" >&2
  exit 1
fi

if [[ ! -f "${output_dir}/TARGET_INFO.json" || ! -f "${output_dir}/BUG_BOUNTY_SCOPE.json" ]]; then
  echo "missing SPECA init files under ${output_dir}" >&2
  echo "expected TARGET_INFO.json and BUG_BOUNTY_SCOPE.json" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found on PATH" >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found on PATH" >&2
  echo "try: export PATH=\"/Applications/Codex.app/Contents/Resources:\$PATH\"" >&2
  exit 1
fi

if [[ "$confirm_external_send" -eq 1 ]]; then
  cat >&2 <<EOF
This will run SPECA target ${target_phase} against:
  ${repo_root}

External-send scope:
  - repository files
  - current uncommitted changes
  - generated SPECA context files under ${output_dir}

Budget note:
  - speca-src config caps phases 02c and 03 at 1000 USD each.

Continue? Type exactly: external-send-ok
EOF
  read -r answer
  if [[ "$answer" != "external-send-ok" ]]; then
    echo "aborted" >&2
    exit 130
  fi
fi

mkdir -p "$output_dir" "$archive_root"

export SPECA_TARGET_WORKSPACE="$repo_root"
export SPECA_OUTPUT_DIR="$output_dir"
export SPECA_ARCHIVE_ROOT="$archive_root"
export CODEX_MODEL="$codex_model"
export SPEC_URLS="${SPEC_URLS:-file://${repo_root}/README.md,file://${repo_root}/docs/CLI.md,file://${repo_root}/docs/STORE_API.md,file://${repo_root}/docs/AGENT_TOOL_CALLING.md,file://${repo_root}/docs/DB_LIFECYCLE.md,file://${repo_root}/docs/SKILL_REGISTRY.md,file://${repo_root}/docs/validation/VFS_VALIDATION_PLAN.md}"
export KEYWORDS="${KEYWORDS:-kinic,wiki,canister,vfs,sqlite,etag,skill registry,agent memory,authorization,stable memory}"

cd "$speca_src"

args=(
  scripts/run_phase.py
  --target "$target_phase"
  --workers "$workers"
  --max-concurrent "$max_concurrent"
  --runtime codex
  --output-dir "$output_dir"
  --archive-root "$archive_root"
  --json
)

if [[ "$force_flag" -eq 1 ]]; then
  args+=(--force)
fi

uv run python "${args[@]}"
