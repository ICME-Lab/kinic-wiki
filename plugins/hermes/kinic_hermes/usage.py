"""Where: plugins/hermes/kinic_hermes/usage.py
What: Read and diff Hermes skill usage sidecar checkpoints.
Why: Native /skill invocations may not appear as tool calls, but Hermes updates .usage.json.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def default_usage_path() -> Path:
    hermes_home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
    return hermes_home / "skills" / ".usage.json"


def read_usage(path: Path | None = None) -> dict[str, Any]:
    data, _ = read_usage_checked(path)
    return data


def read_usage_checked(path: Path | None = None) -> tuple[dict[str, Any], bool]:
    target = path or default_usage_path()
    if not target.exists():
        return {}, True
    try:
        data = json.loads(target.read_text())
    except json.JSONDecodeError:
        return {}, False
    return (data, True) if isinstance(data, dict) else ({}, False)


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
