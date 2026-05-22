#!/usr/bin/env bash
# Where: plugins/claude-code/scripts/evolve-job.sh
# What: Run Claude Code-driven Kinic skill evolution job prepare/finish steps.
# Why: Claude Code must own candidate generation while Kinic CLI owns VFS state.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage:
  evolve-job.sh prepare [job-id]
  evolve-job.sh finish <job-id> <candidate-file>
USAGE
}

projection_dir="${KINIC_SKILL_PROJECTION_DIR:-$HOME/.kinic/skill-projection/skills}"

resolve_runtime_path() {
  local script_dir plugin_root candidate
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  plugin_root="$(cd "$script_dir/.." && pwd)"
  if [ -d "$plugin_root/kinic_agent_runtime" ]; then
    printf '%s\n' "$plugin_root"
    return
  fi
  if [ -n "${KINIC_AGENT_RUNTIME_ROOT:-}" ]; then
    if [ -d "$KINIC_AGENT_RUNTIME_ROOT/kinic_agent_runtime" ]; then
      printf '%s\n' "$KINIC_AGENT_RUNTIME_ROOT"
      return
    fi
    if [ -d "$KINIC_AGENT_RUNTIME_ROOT/plugins/runtime/kinic_agent_runtime" ]; then
      printf '%s\n' "$KINIC_AGENT_RUNTIME_ROOT/plugins/runtime"
      return
    fi
  fi
  candidate="$(cd "$plugin_root/../.." && pwd)"
  if [ -d "$candidate/runtime/kinic_agent_runtime" ]; then
    printf '%s\n' "$candidate/runtime"
    return
  fi
  if [ -d "$candidate/plugins/runtime/kinic_agent_runtime" ]; then
    printf '%s\n' "$candidate/plugins/runtime"
    return
  fi
  printf 'error: Kinic agent runtime not found; reinstall plugin with kinic-vfs-cli claude setup\n' >&2
  exit 69
}

resolve_cli() {
  if [ -n "${KINIC_VFS_CLI:-}" ]; then
    printf '%s\n' "$KINIC_VFS_CLI"
  elif [ -x "$repo_cli" ]; then
    printf '%s\n' "$repo_cli"
  elif command -v kinic-vfs-cli >/dev/null 2>&1; then
    command -v kinic-vfs-cli
  else
    printf 'error: kinic-vfs-cli not found; set KINIC_VFS_CLI or install kinic-vfs-cli in PATH\n' >&2
    exit 69
  fi
}

if [ "$#" -lt 1 ]; then
  usage
  exit 64
fi

command_name="$1"
shift
runtime_path="$(resolve_runtime_path)"
repo_root="$(cd "$runtime_path/.." && pwd)"
repo_cli="$repo_root/target/debug/kinic-vfs-cli"
export PYTHONPATH="$runtime_path${PYTHONPATH:+:$PYTHONPATH}"
cli="$(resolve_cli)"

case "$command_name" in
  prepare)
    if [ "$#" -gt 1 ]; then
      usage
      exit 64
    fi
    if [ "$#" -eq 1 ]; then
      exec python3 -m kinic_agent_runtime.evolve prepare-job "$1" --cli "$cli" --json
    fi
    exec python3 -m kinic_agent_runtime.evolve prepare-job --cli "$cli" --json
    ;;
  finish)
    if [ "$#" -ne 2 ]; then
      usage
      exit 64
    fi
    job_id="$1"
    candidate_file="$2"
    if [ ! -f "$candidate_file" ]; then
      printf 'error: candidate file not found: %s\n' "$candidate_file" >&2
      exit 66
    fi
    exec python3 -m kinic_agent_runtime.evolve finish-job "$job_id" --candidate-file "$candidate_file" --cli "$cli" --projection-dir "$projection_dir" --generator claude-code-plugin --llm-route claude-code-skill
    ;;
  *)
    usage
    exit 64
    ;;
esac
