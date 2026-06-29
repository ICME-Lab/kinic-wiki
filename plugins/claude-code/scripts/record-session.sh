#!/usr/bin/env bash
# Where: plugins/claude-code/scripts/record-session.sh
# What: Record Claude Code SessionEnd hook input as Kinic session evidence.
# Why: Session capture must be best-effort and must never block Claude Code shutdown.
set -euo pipefail

resolve_runtime_path() {
  local script_dir plugin_root candidate
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  plugin_root="$(cd "$script_dir/.." && pwd)"
  export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$plugin_root}"
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
  return 1
}

resolve_cli_optional() {
  if [ -n "${KINIC_VFS_CLI:-}" ]; then
    printf '%s\n' "$KINIC_VFS_CLI"
  elif [ -x "$repo_cli" ]; then
    printf '%s\n' "$repo_cli"
  elif command -v kinic-vfs-cli >/dev/null 2>&1; then
    command -v kinic-vfs-cli
  fi
}

resolve_repo_root() {
  local runtime_path candidate
  runtime_path="$1"
  for candidate in "$runtime_path/.." "$runtime_path/../.."; do
    candidate="$(cd "$candidate" && pwd)"
    if [ -f "$candidate/Cargo.toml" ] && [ -d "$candidate/plugins/runtime/kinic_agent_runtime" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  cd "$runtime_path/.." && pwd
}

runtime_path="$(resolve_runtime_path || true)"
if [ -z "$runtime_path" ]; then
  printf 'warning: Kinic agent runtime not found; skipping Claude session capture\n' >&2
  exit 0
fi

repo_root="$(resolve_repo_root "$runtime_path")"
repo_cli="$repo_root/target/debug/kinic-vfs-cli"
export PYTHONPATH="$runtime_path${PYTHONPATH:+:$PYTHONPATH}"
export CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/kinic-skill-recorder}"

cli="$(resolve_cli_optional || true)"
args=(python3 -m kinic_agent_runtime.session record-claude-session)
if [ -n "$cli" ]; then
  args+=(--cli "$cli")
fi

exec "${args[@]}"
