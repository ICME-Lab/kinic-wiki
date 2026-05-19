"""Where: tools/hermes-kinic-plugin/__init__.py
What: Hermes plugin hooks for Kinic skill evidence recording.
Why: Kinic uses Hermes usage telemetry plus tool/final-output hooks as run evidence.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
import sys

try:
    from .client import KinicClient
    from .schemas import RunBuffer, ToolTrace
    from .usage import read_usage, usage_diff
except ImportError:
    sys.path.insert(0, str(Path(__file__).parent))
    from client import KinicClient
    from schemas import RunBuffer, ToolTrace
    from usage import read_usage, usage_diff


class KinicPlugin:
    def __init__(self) -> None:
        self.client = KinicClient()
        self.checkpoint = read_usage()
        self.buffer = RunBuffer()

    def post_tool_call(self, tool_name: str, args: Any = None, result: Any = None, duration_ms: int | None = None, **_: Any) -> None:
        excerpt = "" if result is None else str(result)[:2000]
        self.buffer.tool_trace.append(ToolTrace(tool_name, args, excerpt, duration_ms))

    def transform_llm_output(self, output: str, **_: Any) -> str:
        self.buffer.final_response = output
        return output

    def post_llm_call(self, **_: Any) -> None:
        current = read_usage()
        deltas = usage_diff(self.checkpoint, current)
        self.checkpoint = current
        if not deltas:
            self.buffer = RunBuffer()
            return
        for skill_id, delta in deltas.items():
            evidence = self.buffer.to_json(skill_id, delta)
            try:
                self.client.record_run(skill_id, evidence)
            except Exception:
                # Hermes turn success must not depend on Kinic availability.
                pass
        self.buffer = RunBuffer()


def register(ctx: Any) -> KinicPlugin:
    plugin = KinicPlugin()
    if hasattr(ctx, "register_hook"):
        ctx.register_hook("post_tool_call", plugin.post_tool_call)
        ctx.register_hook("transform_llm_output", plugin.transform_llm_output)
        ctx.register_hook("post_llm_call", plugin.post_llm_call)
    if hasattr(ctx, "register_tool"):
        try:
            from .tools import kinic_record_correction
        except ImportError:
            from tools import kinic_record_correction

        ctx.register_tool("kinic_record_correction", kinic_record_correction)
    return plugin
