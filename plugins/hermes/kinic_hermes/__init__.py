"""Where: plugins/hermes/kinic_hermes/__init__.py
What: Hermes plugin hooks for Kinic skill evidence recording.
Why: Kinic uses Hermes usage telemetry plus tool/final-output hooks as run evidence.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
import importlib.util
import sys

try:
    from .client import KinicClient
    from .schemas import RunBuffer, ToolTrace
    from .usage import read_usage_checked, usage_diff
except ImportError:
    sys.path.insert(0, str(Path(__file__).parent))
    from client import KinicClient
    from schemas import RunBuffer, ToolTrace
    from usage import read_usage_checked, usage_diff


class KinicPlugin:
    def __init__(self) -> None:
        self.client = KinicClient()
        self.checkpoint, _ = read_usage_checked()
        self.buffer = RunBuffer()
        self.ctx: Any | None = None

    def post_tool_call(self, tool_name: str, args: Any = None, result: Any = None, duration_ms: int | None = None, **_: Any) -> None:
        excerpt = "" if result is None else str(result)[:2000]
        self.buffer.tool_trace.append(ToolTrace(tool_name, args, excerpt, duration_ms))
        if tool_name == "skill_view":
            skill_id = skill_id_from_args(args)
            if skill_id:
                self.buffer.skill_candidates.add(skill_id)

    def transform_llm_output(self, output: str, **_: Any) -> str:
        self.buffer.final_response = output
        return output

    def post_llm_call(self, **_: Any) -> None:
        current, ok = read_usage_checked()
        if not ok:
            self.client._log("invalid Hermes .usage.json; checkpoint unchanged")
            self.buffer = RunBuffer()
            return
        deltas = usage_diff(self.checkpoint, current)
        self.checkpoint = current
        skill_ids = set(deltas) | self.buffer.skill_candidates
        if not skill_ids:
            self.buffer = RunBuffer()
            return
        recording_failed = False
        for skill_id in sorted(skill_ids):
            evidence = self.buffer.to_json(skill_id, deltas.get(skill_id, {}))
            if self.client.record_run(skill_id, evidence):
                continue
            else:
                recording_failed = True
        self.buffer = RunBuffer()
        if recording_failed:
            self.client._log("run recording saved pending evidence")

    def flush_partial(self, reason: str = "session ended before post_llm_call", **_: Any) -> None:
        current, ok = read_usage_checked()
        deltas = usage_diff(self.checkpoint, current) if ok else {}
        skill_ids = set(deltas) | self.buffer.skill_candidates
        for skill_id in sorted(skill_ids):
            evidence = self.buffer.to_json(skill_id, deltas.get(skill_id, {}))
            self.client.save_pending(skill_id, evidence, reason)
        if ok:
            self.checkpoint = current
        self.buffer = RunBuffer()


def register(ctx: Any) -> KinicPlugin:
    plugin = KinicPlugin()
    plugin.ctx = ctx
    if hasattr(ctx, "register_hook"):
        ctx.register_hook("post_tool_call", plugin.post_tool_call)
        ctx.register_hook("transform_llm_output", plugin.transform_llm_output)
        ctx.register_hook("post_llm_call", plugin.post_llm_call)
        ctx.register_hook("on_session_end", plugin.flush_partial)
        ctx.register_hook("on_session_finalize", plugin.flush_partial)
    if hasattr(ctx, "register_tool"):
        try:
            from .tools import kinic_record_correction
        except ImportError:
            spec = importlib.util.spec_from_file_location(
                "kinic_plugin_tools", Path(__file__).with_name("tools.py")
            )
            if spec is None or spec.loader is None:
                raise
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            kinic_record_correction = module.kinic_record_correction

        schema = {
            "name": "kinic_record_correction",
            "description": "Append explicit correction evidence for a Kinic skill run.",
            "parameters": {
                "type": "object",
                "properties": {
                    "skill_id": {"type": "string"},
                    "run_id": {"type": "string"},
                    "notes": {"type": "string"},
                },
                "required": ["skill_id", "run_id", "notes"],
            },
        }

        def handle_correction(params: dict[str, Any], **_: Any) -> str:
            return kinic_record_correction(
                str(params.get("skill_id", "")),
                str(params.get("run_id", "")),
                str(params.get("notes", "")),
            )

        ctx.register_tool(
            name="kinic_record_correction",
            toolset="kinic",
            schema=schema,
            handler=handle_correction,
            description="Append explicit correction evidence for a Kinic skill run.",
        )
    return plugin


def skill_id_from_args(args: Any) -> str | None:
    if isinstance(args, dict):
        value = args.get("name") or args.get("skill") or args.get("skill_id")
        return str(value) if value else None
    if isinstance(args, str):
        return args
    return None
