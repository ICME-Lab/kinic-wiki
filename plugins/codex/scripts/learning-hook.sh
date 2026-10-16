#!/usr/bin/env bash
# Recall task context and record metadata through the shared Kinic hook adapter.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_root="$(cd "$script_dir/.." && pwd)"
runtime_path=""
for candidate in "$plugin_root" "${KINIC_AGENT_RUNTIME_ROOT:-}" "${KINIC_AGENT_RUNTIME_ROOT:-}/plugins/runtime" "$plugin_root/../runtime"; do
  if [ -n "$candidate" ] && [ -d "$candidate/kinic_agent_runtime" ]; then
    runtime_path="$candidate"
    break
  fi
done
if [ -z "$runtime_path" ]; then
  printf 'Kinic learning: shared runtime unavailable; skipping hook\n' >&2
  printf '{}\n'
  exit 0
fi
export PYTHONPATH="$runtime_path${PYTHONPATH:+:$PYTHONPATH}"
exec python3 -m kinic_agent_runtime.learning_hook
