"""Where: plugins/runtime/kinic_agent_runtime/session.py
What: Claude SessionEnd transcript capture and local pending-source rendering.
Why: SessionEnd hooks need compact, redacted raw source payloads without owning DB writes.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_MAX_TEXT_CHARS = 2000
DEFAULT_MAX_TOOL_RESULT_CHARS = 2000
DEFAULT_MAX_CONTENT_CHARS = 24000
PLUGIN_VERSION = "0.1.2"
SECRET_KEY_PATTERN = re.compile(r"(api[_-]?key|authorization|bearer|credential|password|secret|token)", re.I)
SECRET_VALUE_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}"),
    re.compile(r"(?i)\b(api[_-]?key|token|secret|password)=([^\s&]+)"),
]


@dataclass
class CaptureStats:
    redacted: bool = False
    truncated: bool = False
    omitted_tool_result_chars: int = 0


def max_chars_from_env(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, str(default))))
    except ValueError:
        return default


def redact_text(value: str, stats: CaptureStats) -> str:
    redacted = str(value)
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


def truncate_text(value: str, max_chars: int, stats: CaptureStats) -> str:
    if len(value) <= max_chars:
        return value
    stats.truncated = True
    return value[:max_chars]


def compact_tool_result(value: Any, max_chars: int, stats: CaptureStats) -> str:
    if isinstance(value, str):
        text = redact_text(value, stats)
    else:
        text = json.dumps(redact_value(value, stats), ensure_ascii=False, sort_keys=True)
    if len(text) <= max_chars:
        return text
    stats.truncated = True
    head_len = max(0, max_chars // 2)
    tail_len = max(0, max_chars - head_len)
    omitted = len(text) - head_len - tail_len
    stats.omitted_tool_result_chars += max(0, omitted)
    return f"{text[:head_len]}\n...[omitted {max(0, omitted)} chars]...\n{text[-tail_len:] if tail_len else ''}"


def sanitize_json_excerpt(value: Any, max_chars: int, stats: CaptureStats) -> str:
    redacted = redact_value(value, stats)
    text = json.dumps(redacted, ensure_ascii=False, sort_keys=True)
    return truncate_text(text, max_chars, stats)


def event_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("transcript", "messages", "events"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def render_session_source(payload: dict[str, Any]) -> dict[str, Any]:
    stats = CaptureStats()
    max_text = max_chars_from_env("KINIC_SESSION_MAX_TEXT_CHARS", DEFAULT_MAX_TEXT_CHARS)
    max_tool = max_chars_from_env("KINIC_SESSION_MAX_TOOL_RESULT_CHARS", DEFAULT_MAX_TOOL_RESULT_CHARS)
    max_content = max_chars_from_env("KINIC_SESSION_MAX_CONTENT_CHARS", DEFAULT_MAX_CONTENT_CHARS)

    session_id = str(payload.get("session_id") or payload.get("sessionId") or "unknown")
    source = str(payload.get("source") or payload.get("hook") or "claude-code")
    ended_at = payload.get("ended_at") or payload.get("timestamp") or int(time.time() * 1000)

    lines = [
        "# Claude SessionEnd Transcript",
        "",
        f"- session_id: {redact_text(session_id, stats)}",
        f"- source: {redact_text(source, stats)}",
        f"- ended_at: {redact_text(str(ended_at), stats)}",
        "",
        "## Transcript",
        "",
    ]

    refs: list[dict[str, Any]] = []
    for index, item in enumerate(event_items(payload), start=1):
        role = redact_text(str(item.get("role") or item.get("type") or "event"), stats)
        content = item.get("content") or item.get("text") or item.get("message") or ""
        lines.append(f"### {index}. {role}")
        if content:
            lines.append(truncate_text(redact_text(str(content), stats), max_text, stats))
        tool_name = item.get("tool_name") or item.get("name")
        if tool_name:
            lines.append(f"- tool: {redact_text(str(tool_name), stats)}")
        if "tool_input" in item or "input" in item:
            lines.append("- tool_input:")
            lines.append("```json")
            lines.append(sanitize_json_excerpt(item.get("tool_input", item.get("input")), max_text, stats))
            lines.append("```")
        if "tool_result" in item or "result" in item:
            result = item.get("tool_result", item.get("result"))
            compact = compact_tool_result(result, max_tool, stats)
            lines.append("- tool_result_excerpt:")
            lines.append("```")
            lines.append(compact)
            lines.append("```")
            if len(str(result)) > max_tool:
                ref = {"index": index, "tool": str(tool_name or "unknown"), "omitted": True}
                refs.append(redact_value(ref, stats))
        lines.append("")

    if not event_items(payload):
        lines.append("(no transcript events in hook payload)")
        lines.append("")
        lines.append("## Hook payload excerpt")
        lines.append("```json")
        lines.append(sanitize_json_excerpt(payload, max_text, stats))
        lines.append("```")

    content = "\n".join(lines).strip() + "\n"
    content = truncate_text(content, max_content, stats)
    return {
        "schema_version": 1,
        "source_kind": "claude_session_end",
        "title": f"Claude SessionEnd {session_id}",
        "content": content,
        "tool_result_refs": refs,
        "redacted": stats.redacted,
        "truncated": stats.truncated,
        "omitted_tool_result_chars": stats.omitted_tool_result_chars,
        "plugin_version": PLUGIN_VERSION,
        "recorded_locally_at": int(time.time() * 1000),
    }


def default_pending_dir() -> Path:
    root = os.environ.get("KINIC_HOME")
    if root:
        return Path(root) / "pending-sessions"
    return Path.home() / ".kinic" / "pending-sessions"


def save_pending_session(payload: dict[str, Any], pending_dir: Path | None = None) -> Path:
    pending_dir = pending_dir or default_pending_dir()
    pending_dir.mkdir(parents=True, exist_ok=True)
    rendered = render_session_source(payload)
    safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(payload.get("session_id") or payload.get("sessionId") or "unknown"))
    path = pending_dir / f"{int(time.time() * 1000)}-{safe_id}.json"
    path.write_text(json.dumps(rendered, indent=2, ensure_ascii=False))
    return path


def main() -> int:
    parser = argparse.ArgumentParser(prog="kinic-agent-runtime-session")
    subcommands = parser.add_subparsers(dest="command", required=True)
    capture = subcommands.add_parser("capture-claude-session")
    capture.add_argument("--input", help="hook payload JSON file; defaults to stdin")
    capture.add_argument("--pending-dir")
    args = parser.parse_args()
    if args.command == "capture-claude-session":
        text = Path(args.input).read_text() if args.input else sys.stdin.read()
        payload = json.loads(text or "{}")
        path = save_pending_session(payload, Path(args.pending_dir) if args.pending_dir else None)
        print(path)
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
