"""Where: plugins/hermes/kinic_hermes/__init__.py
What: Hermes plugin hooks for Kinic skill evidence recording.
Why: Kinic uses Hermes usage telemetry plus tool/final-output hooks as run evidence.
"""

from __future__ import annotations

import json
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
        self._auto_evolve_running = False

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
        recorded_any = False
        recording_failed = False
        for skill_id in sorted(skill_ids):
            evidence = self.buffer.to_json(skill_id, deltas.get(skill_id, {}))
            if self.client.record_run(skill_id, evidence):
                recorded_any = True
            else:
                recording_failed = True
        self.buffer = RunBuffer()
        if recording_failed:
            self.client._log("auto evolve skipped: run recording saved pending evidence")
        elif recorded_any:
            self.auto_evolve_once()

    def auto_evolve_once(self) -> None:
        """Run at most one queued evolution job after successful run recording."""
        if self._auto_evolve_running:
            self.client._log("auto evolve skipped: already running")
            return
        if self.ctx is None:
            self.client._log("auto evolve skipped: Hermes context unavailable")
            return
        llm = getattr(self.ctx, "llm", None)
        if llm is None or not hasattr(llm, "complete"):
            self.client._log("auto evolve skipped: Hermes ctx.llm unavailable")
            return
        self._auto_evolve_running = True
        try:
            output = handle_kinic_evolve_job(self.ctx, self.client, "")
            self.client._log(f"auto evolve result: {output}")
        except Exception as error:
            self.client._log(f"auto evolve failed: {error}")
        finally:
            self._auto_evolve_running = False

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
    if hasattr(ctx, "register_command"):
        ctx.register_command(
            "kinic_evolve_job",
            lambda *args, **_: handle_kinic_evolve_job(ctx, plugin.client, command_arg(args)),
            "Process one queued Kinic skill evolution job using Hermes ctx.llm.",
        )
    return plugin


def skill_id_from_args(args: Any) -> str | None:
    if isinstance(args, dict):
        value = args.get("name") or args.get("skill") or args.get("skill_id")
        return str(value) if value else None
    if isinstance(args, str):
        return args
    return None


def handle_kinic_evolve_job(ctx: Any, client: KinicClient, argstr: str = "") -> str:
    llm = getattr(ctx, "llm", None)
    if llm is None or not hasattr(llm, "complete"):
        return json.dumps({"error": "Hermes ctx.llm is required for kinic_evolve_job"})
    job_id = argstr.strip() or None
    try:
        prepared = client.prepare_job(job_id)
    except Exception as error:
        return json.dumps({"error": str(error)})
    if "error" in prepared:
        return json.dumps(prepared)
    claimed_job_id = str(prepared["job_id"])
    try:
        result = llm.complete(
            messages=prepared["messages"],
            purpose="kinic.skill-evolve",
        )
        candidate = extract_llm_text(result).strip()
        if candidate.startswith("```"):
            candidate = strip_markdown_fence(candidate)
        output = client.finish_job(claimed_job_id, candidate)
        return output
    except Exception as error:
        complete_error = complete_failed_job(client, claimed_job_id, str(error))
        payload = {"error": str(error), "job_id": claimed_job_id}
        if complete_error:
            payload["complete_error"] = complete_error
        return json.dumps(payload)


def complete_failed_job(client: KinicClient, job_id: str, summary: str) -> str | None:
    try:
        client.complete_job(job_id, "failed", summary)
        return None
    except Exception as error:
        return str(error)


def command_arg(args: tuple[Any, ...]) -> str:
    if not args:
        return ""
    value = args[-1]
    return value if isinstance(value, str) else ""


def extract_llm_text(result: Any) -> str:
    if isinstance(result, dict):
        for key in ("text", "content", "output"):
            if key in result:
                return str(result[key])
    for attr in ("text", "content", "output"):
        value = getattr(result, attr, None)
        if value is not None:
            return str(value)
    return str(result)


def strip_markdown_fence(content: str) -> str:
    text = content.strip()
    lines = text.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip() + "\n"
