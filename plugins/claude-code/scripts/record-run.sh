#!/usr/bin/env bash
# Where: plugins/claude-code/scripts/record-run.sh
# What: Record Claude Code skill run evidence through kinic-vfs-cli.
# Why: Claude Code uses a skill-only plugin; Kinic CLI owns DB writes and job creation.
set -euo pipefail

usage() {
  printf 'usage: %s <skill-id> <evidence-json-file>\n' "$0" >&2
}

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

if [ "$#" -ne 2 ]; then
  usage
  exit 64
fi

skill_id="$1"
evidence_json="$2"

if [ -z "$skill_id" ]; then
  printf 'error: skill id is required\n' >&2
  exit 64
fi

if [ ! -f "$evidence_json" ]; then
  printf 'error: evidence JSON file not found: %s\n' "$evidence_json" >&2
  exit 66
fi

runtime_path="$(resolve_runtime_path)"
repo_root="$(cd "$runtime_path/.." && pwd)"
repo_cli="$repo_root/target/debug/kinic-vfs-cli"
export PYTHONPATH="$runtime_path${PYTHONPATH:+:$PYTHONPATH}"
cli="$(resolve_cli)"
exec python3 -m kinic_agent_runtime.evidence record-run "$skill_id" "$evidence_json" --recorded-by claude-code-plugin --cli "$cli"
