"""Where: plugins/hermes/kinic_hermes/schemas.py
What: Small JSON shapes used by the Hermes Kinic plugin.
Why: The plugin must pass stable run evidence to kinic-vfs-cli without owning DB logic.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any

DEFAULT_MAX_TOOL_ARGS_CHARS = 2000
DEFAULT_MAX_TOOL_RESULT_CHARS = 2000
DEFAULT_MAX_FINAL_RESPONSE_CHARS = 2000
DEFAULT_MAX_RAW_EXCERPT_CHARS = 4000
SECRET_KEY_PATTERN = re.compile(r"(api[_-]?key|authorization|bearer|credential|password|secret|token)", re.I)
SECRET_VALUE_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}"),
    re.compile(r"(?i)\b(api[_-]?key|token|secret|password)=([^\s&]+)"),
]


@dataclass
class ToolTrace:
    name: str
    args: Any
    result_excerpt: str
    duration_ms: int | None = None


@dataclass
class CaptureStats:
    redacted: bool = False
    truncated: bool = False


@dataclass
class RunBuffer:
    tool_trace: list[ToolTrace] = field(default_factory=list)
    skill_candidates: set[str] = field(default_factory=set)
    final_response: str = ""

    def to_json(self, skill_id: str, usage_delta: dict[str, Any], agent_outcome: str = "unknown") -> dict[str, Any]:
        stats = CaptureStats()
        capture_raw = capture_raw_enabled()
        max_chars = {
            "tool_args": max_chars_from_env("KINIC_HERMES_MAX_TOOL_ARGS_CHARS", DEFAULT_MAX_TOOL_ARGS_CHARS),
            "tool_result": max_chars_from_env("KINIC_HERMES_MAX_TOOL_RESULT_CHARS", DEFAULT_MAX_TOOL_RESULT_CHARS),
            "final_response": max_chars_from_env("KINIC_HERMES_MAX_FINAL_RESPONSE_CHARS", DEFAULT_MAX_FINAL_RESPONSE_CHARS),
            "raw_evidence_excerpt": max_chars_from_env("KINIC_HERMES_MAX_RAW_EXCERPT_CHARS", DEFAULT_MAX_RAW_EXCERPT_CHARS),
        }
        tool_trace = [
            sanitize_tool_trace(trace, max_chars, stats) for trace in self.tool_trace
        ] if capture_raw else []
        final_response = sanitize_text(self.final_response, max_chars["final_response"], stats) if capture_raw else ""
        raw_evidence_excerpt = self._excerpt(max_chars, stats) if capture_raw else ""
        return {
            "schema_version": 1,
            "skill_id": skill_id,
            "task": "",
            "task_outcome": "",
            "agent_outcome": agent_outcome,
            "agent": "hermes",
            "recorded_by": "hermes-plugin",
            "summary": self._summary(final_response, capture_raw),
            "raw_evidence_excerpt": raw_evidence_excerpt,
            "usage_delta": usage_delta,
            "tool_trace": tool_trace,
            "final_response": final_response,
            "redacted": stats.redacted,
            "truncated": stats.truncated,
            "max_chars": max_chars,
        }

    def _summary(self, final_response: str, capture_raw: bool) -> str:
        if final_response:
            return final_response[:500]
        if self.tool_trace:
            return f"{len(self.tool_trace)} tool calls captured." if capture_raw else "Raw Hermes capture disabled."
        return "Skill usage detected from Hermes usage sidecar."

    def _excerpt(self, max_chars: dict[str, int], stats: CaptureStats) -> str:
        parts = [sanitize_text(trace.result_excerpt, max_chars["tool_result"], stats) for trace in self.tool_trace if trace.result_excerpt]
        if self.final_response:
            parts.append(sanitize_text(self.final_response, max_chars["final_response"], stats))
        return truncate_text("\n\n".join(parts), max_chars["raw_evidence_excerpt"], stats)


def capture_raw_enabled() -> bool:
    return os.environ.get("KINIC_HERMES_CAPTURE_RAW", "1") != "0"


def max_chars_from_env(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


def sanitize_tool_trace(trace: ToolTrace, max_chars: dict[str, int], stats: CaptureStats) -> dict[str, Any]:
    return {
        "name": trace.name,
        "args": sanitize_json_value(trace.args, max_chars["tool_args"], stats),
        "result_excerpt": sanitize_text(trace.result_excerpt, max_chars["tool_result"], stats),
        "duration_ms": trace.duration_ms,
    }


def sanitize_json_value(value: Any, max_chars: int, stats: CaptureStats) -> Any:
    redacted = redact_value(value, stats)
    try:
        encoded = json.dumps(redacted, ensure_ascii=False, sort_keys=True)
    except TypeError:
        encoded = str(redacted)
    if len(encoded) <= max_chars:
        return redacted
    stats.truncated = True
    return truncate_text(encoded, max_chars, stats)


def redact_value(value: Any, stats: CaptureStats) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            text_key = str(key)
            if SECRET_KEY_PATTERN.search(text_key):
                stats.redacted = True
                redacted[text_key] = "[REDACTED]"
            else:
                redacted[text_key] = redact_value(item, stats)
        return redacted
    if isinstance(value, list):
        return [redact_value(item, stats) for item in value]
    if isinstance(value, tuple):
        return [redact_value(item, stats) for item in value]
    if isinstance(value, str):
        return redact_text(value, stats)
    return value


def sanitize_text(value: str, max_chars: int, stats: CaptureStats) -> str:
    return truncate_text(redact_text(str(value), stats), max_chars, stats)


def redact_text(value: str, stats: CaptureStats) -> str:
    redacted = value
    for pattern in SECRET_VALUE_PATTERNS:
        next_value = pattern.sub(redact_match, redacted)
        if next_value != redacted:
            stats.redacted = True
        redacted = next_value
    return redacted


def redact_match(match: re.Match[str]) -> str:
    if match.lastindex and match.lastindex >= 2:
        return f"{match.group(1)}=[REDACTED]"
    return "[REDACTED]"


def truncate_text(value: str, max_chars: int, stats: CaptureStats) -> str:
    if len(value) <= max_chars:
        return value
    stats.truncated = True
    return value[:max_chars]
