"""Where: tools/hermes-kinic-plugin/usage.py
What: Read and diff Hermes skill usage sidecar checkpoints.
Why: Native /skill invocations may not appear as tool calls, but Hermes updates .usage.json.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def default_usage_path() -> Path:
    return Path.home() / ".hermes" / "skills" / ".usage.json"


def read_usage(path: Path | None = None) -> dict[str, Any]:
    target = path or default_usage_path()
    if not target.exists():
        return {}
    try:
        data = json.loads(target.read_text())
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def usage_diff(previous: dict[str, Any], current: dict[str, Any]) -> dict[str, dict[str, int]]:
    delta: dict[str, dict[str, int]] = {}
    for skill_id, value in current.items():
        if not isinstance(value, dict):
            continue
        old = previous.get(skill_id, {})
        if not isinstance(old, dict):
            old = {}
        counts: dict[str, int] = {}
        for key in ("view_count", "use_count", "patch_count"):
            before = int(old.get(key, 0) or 0)
            after = int(value.get(key, 0) or 0)
            if after > before:
                counts[key] = after - before
        if counts:
            delta[skill_id] = counts
    return delta
