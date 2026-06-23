#!/usr/bin/env bash
# Where: plugins/claude-code/scripts/session-end.sh
# What: Capture Claude Code SessionEnd hook payload as a compact Kinic pending source.
# Why: Session transcripts should be available for later ingestion with redaction and size caps.
set -euo pipefail

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

runtime_path="$(resolve_runtime_path)"
export PYTHONPATH="$runtime_path${PYTHONPATH:+:$PYTHONPATH}"
exec python3 -m kinic_agent_runtime.session capture-claude-session "$@"
