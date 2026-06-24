"""Where: plugins/runtime/kinic_agent_runtime/session.py
What: Persist agent session transcripts as Kinic raw source nodes.
Why: Agent conversations should be retained as source evidence without blocking session exit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .cli import resolve_cli, run_cli


PROVIDER = "claude-code"
SOURCE_PROVIDER = "claudecode"
CODEX_PROVIDER = "codex"
CODEX_SOURCE_PROVIDER = "codex"
MAX_SOURCE_CHARS = 300_000
MAX_TEXT_PART_CHARS = 32_000
MAX_TOOL_INPUT_CHARS = 8_000
SMALL_TOOL_RESULT_CHARS = 4_096
TOOL_RESULT_HEAD_CHARS = 4_096
TOOL_RESULT_TAIL_CHARS = 4_096
TEXT_BUDGET_CHARS = 120_000
TOOL_USE_BUDGET_CHARS = 40_000
TOOL_RESULT_BUDGET_CHARS = 120_000
METADATA_BUDGET_CHARS = 20_000
REDACTED = "[REDACTED]"
SECRET_KEY_PATTERN = re.compile(r"token|secret|password|cookie|authorization|credential|apikey|bearer")
SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(r"\bghp_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bxoxb-[A-Za-z0-9-]{20,}\b"),
    re.compile(r"-----BEGIN (?:OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}"),
    re.compile(
        r'(?i)(?P<prefix>"[^"\\]*(?:api[_.-]?key|token|secret|password|cookie|authorization|credential|bearer)[^"\\]*"\s*:\s*")'
        r'(?P<secret>(?:\\.|[^"\\])*)'
        r'(?P<suffix>")'
    ),
    re.compile(
        r"(?i)\b([A-Za-z0-9_.-]*(?:api[_.-]?key|token|secret|password|cookie|credential|bearer)[A-Za-z0-9_.-]*)\b(\s*[:=]\s*)([^\s'\"`]+)"
    ),
    re.compile(r"(?i)\b(authorization)(\s*[:=]\s*)([^\n]+)"),
]


@dataclass(frozen=True)
class HookInput:
    session_id: str
    transcript_path: Path
    cwd: str
    reason: str


@dataclass(frozen=True)
class SourcePayload:
    path: str
    content: str
    metadata: dict[str, Any]


@dataclass(frozen=True)
class RenderedText:
    text: str
    redacted: bool = False
    truncated_parts: int = 0
    omitted_chars: int = 0
    tool_result_original_chars: int = 0
    tool_result_saved_chars: int = 0
    tool_result_refs: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class FlushPendingResult:
    flushed: list[Path] = field(default_factory=list)
    failed: list[Path] = field(default_factory=list)
    invalid: list[Path] = field(default_factory=list)


@dataclass
class CaptureContext:
    text_remaining: int = TEXT_BUDGET_CHARS
    tool_use_remaining: int = TOOL_USE_BUDGET_CHARS
    tool_result_remaining: int = TOOL_RESULT_BUDGET_CHARS
    last_tool_name: str = "unknown"
    last_tool_input: dict[str, Any] = field(default_factory=dict)
    tool_names_by_id: dict[str, str] = field(default_factory=dict)
    tool_inputs_by_id: dict[str, dict[str, Any]] = field(default_factory=dict)

    def consume(self, bucket: str, requested: int) -> int:
        if bucket == "text":
            saved = min(requested, self.text_remaining)
            self.text_remaining -= saved
            return saved
        if bucket == "tool_use":
            saved = min(requested, self.tool_use_remaining)
            self.tool_use_remaining -= saved
            return saved
        if bucket == "tool_result":
            saved = min(requested, self.tool_result_remaining)
            self.tool_result_remaining -= saved
            return saved
        return requested

    def budget_metadata(self) -> dict[str, dict[str, int]]:
        return {
            "text": {"limit": TEXT_BUDGET_CHARS, "used": TEXT_BUDGET_CHARS - self.text_remaining},
            "tool_use": {"limit": TOOL_USE_BUDGET_CHARS, "used": TOOL_USE_BUDGET_CHARS - self.tool_use_remaining},
            "tool_result": {
                "limit": TOOL_RESULT_BUDGET_CHARS,
                "used": TOOL_RESULT_BUDGET_CHARS - self.tool_result_remaining,
            },
            "metadata": {"limit": METADATA_BUDGET_CHARS, "used": 0},
            "total": {"limit": MAX_SOURCE_CHARS, "used": 0},
        }


def parse_hook_input(raw: str) -> HookInput:
    data = json.loads(raw)
    session_id = required_text(data, "session_id")
    transcript_path = Path(required_text(data, "transcript_path"))
    cwd = text_value(data.get("cwd"))
    reason = text_value(data.get("reason"))
    return HookInput(session_id=session_id, transcript_path=transcript_path, cwd=cwd, reason=reason)


def parse_codex_hook_input(raw: str) -> HookInput:
    data = json.loads(raw)
    session_id = required_text(data, "session_id")
    transcript_path = Path(required_text(data, "transcript_path"))
    cwd = text_value(data.get("cwd"))
    reason = text_value(data.get("hook_event_name")) or text_value(data.get("reason")) or "Stop"
    return HookInput(session_id=session_id, transcript_path=transcript_path, cwd=cwd, reason=reason)


def required_text(data: Any, key: str) -> str:
    if not isinstance(data, dict):
        raise ValueError("hook input must be a JSON object")
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"hook input {key} is required")
    return value


def text_value(value: Any) -> str:
    return value if isinstance(value, str) else ""


def build_source(
    hook: HookInput,
    now_ms: int | None = None,
    max_chars: int = MAX_SOURCE_CHARS,
    provider: str = PROVIDER,
    source_provider: str = SOURCE_PROVIDER,
    transcript_parser: Any | None = None,
) -> SourcePayload:
    captured_at = rfc3339_now(now_ms)
    context = CaptureContext()
    parser = parse_transcript if transcript_parser is None else transcript_parser
    (
        entries,
        structured_redacted,
        truncated_parts,
        omitted_chars,
        tool_result_original_chars,
        tool_result_saved_chars,
        tool_result_refs,
    ) = parser(hook.transcript_path, context)
    transcript = transcript_markdown(entries)
    redacted_transcript, text_redacted = redact(transcript)
    session_id, session_id_redacted = redact(hook.session_id)
    cwd, cwd_redacted = redact(hook.cwd)
    reason, reason_redacted = redact(hook.reason)
    transcript_path, transcript_path_redacted = redact(str(hook.transcript_path))
    redacted = any(
        [
            structured_redacted,
            text_redacted,
            session_id_redacted,
            cwd_redacted,
            reason_redacted,
            transcript_path_redacted,
        ]
    )
    source_id = source_id_for_session(hook.session_id, hook.transcript_path, captured_at)
    budget = context.budget_metadata()
    metadata = {
        "provider": provider,
        "session_id": session_id,
        "cwd": cwd,
        "ended_reason": reason,
        "captured_at": captured_at,
        "transcript_path": transcript_path,
        "message_count": len(entries),
        "redacted": redacted,
        "truncated": truncated_parts > 0,
        "truncated_parts": truncated_parts,
        "omitted_chars": omitted_chars,
        "tool_result_original_chars": tool_result_original_chars,
        "tool_result_saved_chars": tool_result_saved_chars,
        "tool_result_refs": tool_result_refs,
        "budget": budget,
        "original_chars": 0,
        "saved_chars": 0,
    }
    content = source_content_with_cap(metadata, redacted_transcript, max_chars)
    return SourcePayload(
        path=f"/Sources/raw/{source_provider}/{source_id}.md",
        content=content,
        metadata=metadata,
    )


def build_codex_source(
    hook: HookInput, now_ms: int | None = None, max_chars: int = MAX_SOURCE_CHARS
) -> SourcePayload:
    return build_source(
        hook,
        now_ms=now_ms,
        max_chars=max_chars,
        provider=CODEX_PROVIDER,
        source_provider=CODEX_SOURCE_PROVIDER,
        transcript_parser=parse_codex_transcript,
    )


def source_content_with_cap(metadata: dict[str, Any], transcript: str, max_chars: int) -> str:
    base_truncated = bool(metadata["truncated"])
    base_truncated_parts = int(metadata["truncated_parts"])
    base_omitted_chars = int(metadata["omitted_chars"])
    metadata["budget"]["metadata"]["used"] = len(render_source_content(metadata, ""))
    for _ in range(8):
        original_chars = len(render_source_content(metadata, transcript))
        if metadata["original_chars"] == original_chars:
            break
        metadata["original_chars"] = original_chars

    transcript_limit = len(transcript)
    final_content = ""
    final_metadata = metadata
    while True:
        final_truncated = transcript_limit < len(transcript)
        if final_truncated:
            limited_transcript, _ = limit_text(transcript, transcript_limit)
            final_omitted_chars = max(0, len(transcript) - transcript_limit)
        else:
            limited_transcript = transcript
            final_omitted_chars = 0
        final_metadata = finalized_source_metadata(
            metadata,
            base_truncated,
            base_truncated_parts,
            base_omitted_chars,
            final_truncated,
            final_omitted_chars,
        )
        final_content = stabilize_saved_source_content(final_metadata, limited_transcript)
        if len(final_content) <= max_chars:
            break
        if transcript_limit <= 0:
            final_content = final_content[:max_chars]
            break
        transcript_limit = max(0, transcript_limit - (len(final_content) - max_chars) - 128)

    final_metadata["saved_chars"] = len(final_content)
    final_metadata["budget"]["total"]["used"] = len(final_content)
    final_metadata["budget"]["metadata"]["used"] = len(render_source_content(final_metadata, ""))
    metadata.clear()
    metadata.update(final_metadata)
    return final_content


def finalized_source_metadata(
    metadata: dict[str, Any],
    base_truncated: bool,
    base_truncated_parts: int,
    base_omitted_chars: int,
    final_truncated: bool,
    final_omitted_chars: int,
) -> dict[str, Any]:
    next_metadata = dict(metadata)
    next_budget = {key: dict(value) for key, value in metadata["budget"].items()}
    next_metadata["budget"] = next_budget
    next_metadata["truncated"] = base_truncated or final_truncated
    next_metadata["truncated_parts"] = base_truncated_parts + (1 if final_truncated else 0)
    next_metadata["omitted_chars"] = base_omitted_chars + final_omitted_chars
    return next_metadata


def stabilize_saved_source_content(metadata: dict[str, Any], transcript: str) -> str:
    for _ in range(8):
        metadata["budget"]["metadata"]["used"] = len(render_source_content(metadata, ""))
        content = render_source_content(metadata, transcript)
        saved_chars = len(content)
        if metadata["saved_chars"] == saved_chars and metadata["budget"]["total"]["used"] == saved_chars:
            return content
        metadata["saved_chars"] = saved_chars
        metadata["budget"]["total"]["used"] = saved_chars
    return render_source_content(metadata, transcript)


def render_source_content(metadata: dict[str, Any], transcript: str) -> str:
    title = "Raw Codex Session" if metadata["provider"] == CODEX_PROVIDER else "Raw Claude Code Session"
    lines = [
        f"# {title}",
        "",
        "## Metadata",
        "",
        f"- provider: {json.dumps(metadata['provider'])}",
        f"- session_id: {json.dumps(metadata['session_id'])}",
        f"- cwd: {json.dumps(metadata['cwd'])}",
        f"- ended_reason: {json.dumps(metadata['ended_reason'])}",
        f"- captured_at: {json.dumps(metadata['captured_at'])}",
        f"- transcript_path: {json.dumps(metadata['transcript_path'])}",
        f"- message_count: {metadata['message_count']}",
        f"- redacted: {str(metadata['redacted']).lower()}",
        f"- truncated: {str(metadata['truncated']).lower()}",
        f"- truncated_parts: {metadata['truncated_parts']}",
        f"- omitted_chars: {metadata['omitted_chars']}",
        f"- tool_result_original_chars: {metadata['tool_result_original_chars']}",
        f"- tool_result_saved_chars: {metadata['tool_result_saved_chars']}",
        f"- original_chars: {metadata['original_chars']}",
        f"- saved_chars: {metadata['saved_chars']}",
        "",
        "## Transcript",
        "",
        transcript,
    ]
    return "\n".join(lines).rstrip() + "\n"


def parse_transcript(
    path: Path, context: CaptureContext
) -> tuple[list[tuple[str, str]], bool, int, int, int, int, list[dict[str, Any]]]:
    entries: list[tuple[str, str]] = []
    redacted = False
    truncated_parts = 0
    omitted_chars = 0
    tool_result_original_chars = 0
    tool_result_saved_chars = 0
    tool_result_refs: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            role = role_from_entry(data)
            content = content_from_entry(data, context)
            if role and content.text:
                entries.append((role, content.text))
                redacted = redacted or content.redacted
                truncated_parts += content.truncated_parts
                omitted_chars += content.omitted_chars
                tool_result_original_chars += content.tool_result_original_chars
                tool_result_saved_chars += content.tool_result_saved_chars
                tool_result_refs.extend(content.tool_result_refs)
    return (
        entries,
        redacted,
        truncated_parts,
        omitted_chars,
        tool_result_original_chars,
        tool_result_saved_chars,
        tool_result_refs,
    )


def parse_codex_transcript(
    path: Path, context: CaptureContext
) -> tuple[list[tuple[str, str]], bool, int, int, int, int, list[dict[str, Any]]]:
    entries: list[tuple[str, str]] = []
    redacted = False
    truncated_parts = 0
    omitted_chars = 0
    tool_result_original_chars = 0
    tool_result_saved_chars = 0
    tool_result_refs: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            role, content = codex_role_and_content(data, context)
            if role and content.text:
                entries.append((role, content.text))
                redacted = redacted or content.redacted
                truncated_parts += content.truncated_parts
                omitted_chars += content.omitted_chars
                tool_result_original_chars += content.tool_result_original_chars
                tool_result_saved_chars += content.tool_result_saved_chars
                tool_result_refs.extend(content.tool_result_refs)
    return (
        entries,
        redacted,
        truncated_parts,
        omitted_chars,
        tool_result_original_chars,
        tool_result_saved_chars,
        tool_result_refs,
    )


def codex_role_and_content(data: Any, context: CaptureContext) -> tuple[str, RenderedText]:
    if not isinstance(data, dict):
        return "", RenderedText("")
    payload = data.get("payload")
    if not isinstance(payload, dict):
        return "", RenderedText("")
    record_type = data.get("type")
    payload_type = payload.get("type")
    if record_type == "event_msg":
        if payload_type == "user_message":
            return "user", content_text(payload.get("message") or payload.get("text_elements"), context)
        if payload_type == "agent_message":
            return "assistant", content_text(payload.get("message"), context)
    if record_type != "response_item":
        return "", RenderedText("")
    if payload_type == "message":
        role = payload.get("role")
        if role not in {"user", "assistant", "system"}:
            role = "assistant"
        return role, content_text(payload.get("content"), context)
    if payload_type == "function_call":
        call_id = text_value(payload.get("call_id")) or text_value(payload.get("id"))
        part = {
            "type": "tool_use",
            "id": call_id,
            "name": text_value(payload.get("name")) or "tool",
            "input": codex_function_arguments(payload.get("arguments")),
        }
        return "tool_use", content_part_text(part, context)
    if payload_type == "function_call_output":
        part = {
            "type": "tool_result",
            "tool_use_id": text_value(payload.get("call_id")) or text_value(payload.get("id")),
            "content": payload.get("output"),
        }
        return "tool_result", content_part_text(part, context)
    return "", RenderedText("")


def codex_function_arguments(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return {"arguments": value}
    return value if value is not None else {}


def role_from_entry(data: Any) -> str:
    if not isinstance(data, dict):
        return ""
    message = data.get("message")
    if isinstance(message, dict):
        role = message.get("role")
        if role in {"user", "assistant", "system"}:
            return role
    entry_type = data.get("type")
    if entry_type in {"user", "assistant", "system"}:
        return entry_type
    if entry_type in {"tool_use", "tool_result"}:
        return entry_type
    return ""


def content_from_entry(data: Any, context: CaptureContext) -> RenderedText:
    if not isinstance(data, dict):
        return RenderedText("")
    if isinstance(data.get("message"), dict):
        return content_text(data["message"].get("content"), context)
    return content_text(data.get("content"), context)


def content_text(
    value: Any,
    context: CaptureContext,
    text_limit: int | None = MAX_TEXT_PART_CHARS,
    bucket: str | None = "text",
) -> RenderedText:
    if isinstance(value, str):
        return redact_and_limit_text(value.strip(), text_limit, bucket, context)
    if isinstance(value, list):
        parts = [content_part_text(part, context, text_limit, bucket) for part in value]
        text = "\n".join(part.text for part in parts if part.text).strip()
        return RenderedText(
            text,
            any(part.redacted for part in parts),
            sum(part.truncated_parts for part in parts),
            sum(part.omitted_chars for part in parts),
            sum(part.tool_result_original_chars for part in parts),
            sum(part.tool_result_saved_chars for part in parts),
            [item for part in parts for item in part.tool_result_refs],
        )
    if isinstance(value, dict):
        if not looks_like_content_part(value):
            redacted_value, redacted = redact_value(value)
            rendered = json.dumps(redacted_value, ensure_ascii=False, sort_keys=True)
            limited = limit_rendered(rendered, text_limit, bucket, context)
            return RenderedText(
                limited.text,
                redacted or limited.redacted,
                limited.truncated_parts,
                limited.omitted_chars,
            )
        part = content_part_text(value, context, text_limit, bucket)
        return RenderedText(
            part.text.strip(),
            part.redacted,
            part.truncated_parts,
            part.omitted_chars,
            part.tool_result_original_chars,
            part.tool_result_saved_chars,
            part.tool_result_refs,
        )
    return RenderedText("")


def looks_like_content_part(value: dict[str, Any]) -> bool:
    return "type" in value or "text" in value or "content" in value


def content_part_text(
    part: Any,
    context: CaptureContext,
    text_limit: int | None = MAX_TEXT_PART_CHARS,
    bucket: str | None = "text",
) -> RenderedText:
    if isinstance(part, str):
        return redact_and_limit_text(part.strip(), text_limit, bucket, context)
    if not isinstance(part, dict):
        return RenderedText("")
    part_type = part.get("type")
    if part_type == "text" and isinstance(part.get("text"), str):
        return redact_and_limit_text(part["text"].strip(), text_limit, bucket, context)
    if part_type == "tool_use":
        name = text_value(part.get("name")) or "tool"
        context.last_tool_name = name
        tool_id = text_value(part.get("id")) or text_value(part.get("tool_use_id"))
        redacted_input, input_redacted = redact_value(part.get("input", {}))
        context.last_tool_input = redacted_input if isinstance(redacted_input, dict) else {}
        if tool_id:
            context.tool_names_by_id[tool_id] = name
            context.tool_inputs_by_id[tool_id] = context.last_tool_input
        tool_input = json.dumps(redacted_input, ensure_ascii=False, sort_keys=True)
        limited_input = limit_rendered(tool_input, MAX_TOOL_INPUT_CHARS, "tool_use", context)
        return RenderedText(
            f"[tool_use: {name}]\n{limited_input.text}",
            input_redacted,
            limited_input.truncated_parts,
            limited_input.omitted_chars,
        )
    if part_type == "tool_result":
        tool_name = tool_name_for_result(part, context)
        tool_use_id = tool_use_id_for_result(part, context)
        tool_input = tool_input_for_result(part, context)
        return render_tool_result(tool_name, tool_use_id, tool_input, part, context)
    if isinstance(part.get("text"), str):
        return redact_and_limit_text(part["text"].strip(), text_limit, bucket, context)
    if isinstance(part.get("content"), (str, list, dict)):
        return content_text(part.get("content"), context, text_limit, bucket)
    return RenderedText("")


def transcript_markdown(entries: list[tuple[str, str]]) -> str:
    lines: list[str] = []
    for index, (role, content) in enumerate(entries, start=1):
        lines.extend(
            [
                f"### Turn {index:04d}",
                "",
                f"- role: {role}",
                "",
                content.strip(),
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def tool_name_for_result(part: dict[str, Any], context: CaptureContext) -> str:
    tool_id = text_value(part.get("tool_use_id")) or text_value(part.get("id"))
    if tool_id and tool_id in context.tool_names_by_id:
        return context.tool_names_by_id[tool_id]
    return text_value(part.get("name")) or context.last_tool_name or "unknown"


def tool_use_id_for_result(part: dict[str, Any], context: CaptureContext) -> str:
    tool_id = text_value(part.get("tool_use_id")) or text_value(part.get("id"))
    if tool_id:
        return tool_id
    return ""


def tool_input_for_result(part: dict[str, Any], context: CaptureContext) -> dict[str, Any]:
    tool_id = text_value(part.get("tool_use_id")) or text_value(part.get("id"))
    if tool_id and tool_id in context.tool_inputs_by_id:
        return context.tool_inputs_by_id[tool_id]
    return context.last_tool_input


def render_tool_result(
    tool_name: str, tool_use_id: str, tool_input: dict[str, Any], part: dict[str, Any], context: CaptureContext
) -> RenderedText:
    value = part.get("content")
    redacted_value, value_redacted = redact_value(value)
    body = tool_result_body(tool_name, redacted_value)
    redacted_text, text_redacted = redact(body)
    status = tool_result_status(part, redacted_value)
    result_fields = tool_result_fields(tool_name, redacted_value)
    compacted = compact_tool_result(tool_name, tool_use_id, tool_input, result_fields, redacted_text, status, context)
    return RenderedText(
        compacted.text,
        value_redacted or text_redacted,
        compacted.truncated_parts,
        compacted.omitted_chars,
        compacted.tool_result_original_chars,
        compacted.tool_result_saved_chars,
        compacted.tool_result_refs,
    )


def tool_result_status(part: dict[str, Any], value: Any) -> str:
    if part.get("is_error") is True:
        return "error"
    if isinstance(value, dict):
        for key in ("status", "exit_code", "exitCode"):
            if key in value:
                return str(value[key])
    return "unknown"


def tool_result_fields(tool_name: str, value: Any) -> list[tuple[str, Any]]:
    normalized = tool_name.lower()
    fields: list[tuple[str, Any]] = []
    if normalized == "bash" and isinstance(value, dict):
        for key in ("exit_code", "exitCode", "status"):
            if key in value:
                fields.append(("exit_code" if key == "exitCode" else key, value[key]))
                break
    return fields


def tool_result_body(tool_name: str, value: Any) -> str:
    normalized = tool_name.lower()
    if normalized == "bash" and isinstance(value, dict):
        lines: list[str] = []
        for key in ("stdout", "stderr"):
            if key in value:
                lines.extend([f"--- {key} ---", text_or_json(value[key]), ""])
        rest = {key: item for key, item in value.items() if key not in {"stdout", "stderr", "exit_code", "exitCode", "status"}}
        if rest:
            lines.extend(["--- result ---", json.dumps(rest, ensure_ascii=False, sort_keys=True)])
        return "\n".join(lines).strip()
    return text_or_json(value).strip()


def text_or_json(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def compact_tool_result(
    tool_name: str,
    tool_use_id: str,
    tool_input: dict[str, Any],
    result_fields: list[tuple[str, Any]],
    value: str,
    status: str,
    context: CaptureContext,
) -> RenderedText:
    original_chars = len(value)
    if original_chars <= SMALL_TOOL_RESULT_CHARS:
        allowed = context.consume("tool_result", original_chars)
        if allowed >= original_chars:
            body = "\n".join(
                [*tool_result_header(tool_name, tool_use_id, tool_input, result_fields, status, False), "", value]
            ).rstrip()
            ref = tool_result_ref(tool_name, tool_use_id, original_chars, original_chars, False)
            return RenderedText(
                body,
                tool_result_original_chars=original_chars,
                tool_result_saved_chars=original_chars,
                tool_result_refs=[ref],
            )
        if allowed <= 0:
            text = tool_result_placeholder(tool_name, tool_use_id, tool_input, result_fields, status, original_chars)
            ref = tool_result_ref(tool_name, tool_use_id, original_chars, 0, True)
            return RenderedText(
                text,
                truncated_parts=1,
                omitted_chars=original_chars,
                tool_result_original_chars=original_chars,
                tool_result_saved_chars=0,
                tool_result_refs=[ref],
            )
        return compact_tool_result_excerpt(
            tool_name, tool_use_id, tool_input, result_fields, value, status, original_chars, allowed
        )

    requested = min(TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS, original_chars)
    allowed = context.consume("tool_result", requested)
    if allowed <= 0:
        text = tool_result_placeholder(tool_name, tool_use_id, tool_input, result_fields, status, original_chars)
        ref = tool_result_ref(tool_name, tool_use_id, original_chars, 0, True)
        return RenderedText(
            text,
            truncated_parts=1,
            omitted_chars=original_chars,
            tool_result_original_chars=original_chars,
            tool_result_saved_chars=0,
            tool_result_refs=[ref],
        )

    return compact_tool_result_excerpt(
        tool_name, tool_use_id, tool_input, result_fields, value, status, original_chars, allowed
    )


def compact_tool_result_excerpt(
    tool_name: str,
    tool_use_id: str,
    tool_input: dict[str, Any],
    result_fields: list[tuple[str, Any]],
    value: str,
    status: str,
    original_chars: int,
    allowed: int,
) -> RenderedText:
    allowed = min(allowed, original_chars)
    head_chars = min(TOOL_RESULT_HEAD_CHARS, (allowed + 1) // 2)
    tail_chars = max(0, allowed - head_chars)
    head = value[:head_chars]
    tail = value[-tail_chars:] if tail_chars else ""
    saved_chars = len(head) + len(tail)
    truncated = saved_chars < original_chars
    text = "\n".join(
        [
            *tool_result_header(tool_name, tool_use_id, tool_input, result_fields, status, truncated),
            f"original_chars: {original_chars}",
            f"saved_chars: {saved_chars}",
            "",
            "--- head ---",
            head,
            "",
            "--- tail ---",
            tail,
        ]
    ).rstrip()
    ref = tool_result_ref(tool_name, tool_use_id, original_chars, saved_chars, False)
    return RenderedText(
        text,
        truncated_parts=1 if truncated else 0,
        omitted_chars=max(0, original_chars - saved_chars),
        tool_result_original_chars=original_chars,
        tool_result_saved_chars=saved_chars,
        tool_result_refs=[ref],
    )


def tool_result_header(
    tool_name: str,
    tool_use_id: str,
    tool_input: dict[str, Any],
    result_fields: list[tuple[str, Any]],
    status: str,
    truncated: bool,
) -> list[str]:
    lines = [
        f"[tool_result: {tool_name}]",
        f"status: {status}",
        f"truncated: {str(truncated).lower()}",
    ]
    if tool_use_id:
        lines.append(f"tool_use_id: {json.dumps(tool_use_id, ensure_ascii=False)}")
    for key, value in tool_policy_fields(tool_name, tool_input):
        lines.append(f"{key}: {json.dumps(value, ensure_ascii=False)}")
    for key, value in result_fields:
        lines.append(f"{key}: {json.dumps(value, ensure_ascii=False)}")
    return lines


def tool_policy_fields(tool_name: str, tool_input: dict[str, Any]) -> list[tuple[str, Any]]:
    normalized = tool_name.lower()
    fields: list[tuple[str, Any]] = []
    if normalized == "bash":
        command = tool_input.get("command")
        if isinstance(command, str):
            fields.append(("command", command))
    elif normalized == "read":
        for key in ("file_path", "path", "offset", "limit"):
            if key in tool_input:
                fields.append((key, tool_input[key]))
    elif normalized in {"edit", "write"}:
        for key in ("file_path", "path"):
            if key in tool_input:
                fields.append((key, tool_input[key]))
    elif normalized in {"grep", "search"}:
        for key in ("pattern", "path", "glob"):
            if key in tool_input:
                fields.append((key, tool_input[key]))
    elif normalized == "webfetch":
        for key in ("url", "prompt"):
            if key in tool_input:
                fields.append((key, tool_input[key]))
    return fields


def tool_result_placeholder(
    tool_name: str,
    tool_use_id: str,
    tool_input: dict[str, Any],
    result_fields: list[tuple[str, Any]],
    status: str,
    original_chars: int,
) -> str:
    return "\n".join(
        [
            *tool_result_header(tool_name, tool_use_id, tool_input, result_fields, status, True),
            f"original_chars: {original_chars}",
            "saved_chars: 0",
            "budget_exhausted: true",
        ]
    )


def tool_result_ref(
    tool_name: str, tool_use_id: str, original_chars: int, saved_chars: int, budget_exhausted: bool
) -> dict[str, Any]:
    ref: dict[str, Any] = {
        "tool": tool_name,
        "original_chars": original_chars,
        "saved_chars": saved_chars,
        "omitted_chars": max(0, original_chars - saved_chars),
        "budget_exhausted": budget_exhausted,
    }
    if tool_use_id:
        ref["tool_use_id"] = tool_use_id
    return ref


def limit_rendered(value: str, max_chars: int | None, bucket: str | None, context: CaptureContext) -> RenderedText:
    if max_chars is None:
        return RenderedText(value)
    requested = min(len(value), max_chars)
    allowed = requested if bucket is None else min(max_chars, context.consume(bucket, requested))
    if len(value) <= allowed:
        return RenderedText(value)
    if allowed <= 0:
        placeholder = f"[omitted: original_chars={len(value)} saved_chars=0]"
        return RenderedText(placeholder, truncated_parts=1, omitted_chars=len(value))
    limited, _ = limit_text(value, allowed)
    return RenderedText(limited, truncated_parts=1, omitted_chars=len(value) - allowed)


def redact_and_limit_text(
    value: str, max_chars: int | None, bucket: str | None, context: CaptureContext
) -> RenderedText:
    redacted_value, redacted = redact(value)
    limited = limit_rendered(redacted_value, max_chars, bucket, context)
    return RenderedText(
        limited.text,
        redacted or limited.redacted,
        limited.truncated_parts,
        limited.omitted_chars,
        limited.tool_result_original_chars,
        limited.tool_result_saved_chars,
        limited.tool_result_refs,
    )


def redact(value: str) -> tuple[str, bool]:
    redacted = value
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub(redact_match, redacted)
    return redacted, redacted != value


def redact_value(value: Any) -> tuple[Any, bool]:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        changed = False
        for key, item in value.items():
            text_key = str(key)
            if is_secret_key(text_key):
                redacted[text_key] = REDACTED
                changed = changed or item != REDACTED
            else:
                redacted_item, item_changed = redact_value(item)
                redacted[text_key] = redacted_item
                changed = changed or item_changed
        return redacted, changed
    if isinstance(value, list):
        redacted_items = []
        changed = False
        for item in value:
            redacted_item, item_changed = redact_value(item)
            redacted_items.append(redacted_item)
            changed = changed or item_changed
        return redacted_items, changed
    if isinstance(value, str):
        return redact(value)
    return value, False


def is_secret_key(value: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", value.lower())
    return bool(SECRET_KEY_PATTERN.search(normalized))


def redact_match(match: re.Match[str]) -> str:
    prefix = match.groupdict().get("prefix")
    if prefix is not None:
        return f"{prefix}{REDACTED}{match.groupdict().get('suffix', '')}"
    if len(match.groups()) >= 3:
        return f"{match.group(1)}{match.group(2)}{REDACTED}"
    if len(match.groups()) == 1:
        return f"{match.group(1)}{REDACTED}"
    return REDACTED


def limit_text(value: str, max_chars: int) -> tuple[str, bool]:
    if len(value) <= max_chars:
        return value, False
    limited = value[:max_chars].rstrip()
    limited = complete_trailing_redaction_marker(limited, max_chars)
    return limited + f"\n\n[truncated: original_chars={len(value)} saved_chars={len(limited)}]\n", True


def complete_trailing_redaction_marker(value: str, max_chars: int) -> str:
    for size in range(len(REDACTED) - 1, 0, -1):
        if value.endswith(REDACTED[:size]):
            prefix = value[: -size]
            return prefix[: max(0, max_chars - len(REDACTED))].rstrip() + REDACTED
    return value


def save_pending(pending_dir: Path, source: SourcePayload, now_ms: int | None = None) -> Path:
    pending_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        pending_dir.chmod(0o700)
    except OSError:
        pass
    millis = now_ms if now_ms is not None else int(time.time() * 1000)
    stem = safe_source_stem(Path(source.path).stem)
    payload = {
        "schema_version": 1,
        "kind": pending_kind_for_source(source),
        "path": source.path,
        "content": source.content,
        "metadata_json": json.dumps(source.metadata, ensure_ascii=False, sort_keys=True),
        "saved_locally_at": millis,
    }
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    for attempt in range(100):
        suffix = "" if attempt == 0 else f"-{attempt}"
        path = pending_dir / f"{millis}-{stem}{suffix}.json"
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(body)
        return path
    raise FileExistsError(f"pending session path already exists for {millis}-{stem}")


def pending_kind_for_source(source: SourcePayload) -> str:
    if source.metadata.get("provider") == CODEX_PROVIDER:
        return "codex_session_source"
    return "claude_code_session_source"


def flush_pending(cli: str, pending_dir: Path) -> list[Path]:
    return flush_pending_report(cli, pending_dir).flushed


def flush_pending_report(cli: str, pending_dir: Path, skip_paths: set[Path] | None = None) -> FlushPendingResult:
    flushed: list[Path] = []
    failed: list[Path] = []
    invalid: list[Path] = []
    if not pending_dir.is_dir():
        return FlushPendingResult(flushed=flushed, failed=failed, invalid=invalid)
    skipped = {path.resolve() for path in skip_paths or set()}
    for path in sorted(pending_dir.glob("*.json")):
        if path.resolve() in skipped:
            continue
        try:
            payload = json.loads(path.read_text())
        except json.JSONDecodeError:
            invalid.append(quarantine_pending(path, "invalid"))
            continue
        except OSError:
            failed.append(quarantine_pending(path, "failed"))
            continue
        try:
            write_payload(cli, payload)
        except ValueError:
            invalid.append(quarantine_pending(path, "invalid"))
            continue
        except (OSError, subprocess.CalledProcessError):
            failed.append(path)
            continue
        try:
            path.unlink()
        except OSError:
            failed.append(quarantine_pending(path, "failed"))
            continue
        flushed.append(path)
    return FlushPendingResult(flushed=flushed, failed=failed, invalid=invalid)


def quarantine_pending(path: Path, suffix: str) -> Path:
    target = unique_quarantine_path(path, suffix)
    try:
        path.replace(target)
        return target
    except OSError:
        return path


def unique_quarantine_path(path: Path, suffix: str) -> Path:
    target = path.with_name(f"{path.name}.{suffix}")
    if not target.exists():
        return target
    millis = int(time.time() * 1000)
    return path.with_name(f"{path.name}.{millis}.{suffix}")


def write_payload(cli: str, payload: dict[str, Any]) -> None:
    content = required_text(payload, "content")
    remote_path = required_text(payload, "path")
    metadata_json = required_text(payload, "metadata_json")
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    try:
        run_cli(
            cli,
            "write-node",
            "--path",
            remote_path,
            "--kind",
            "source",
            "--input",
            str(temp_path),
            "--metadata-json",
            metadata_json,
            "--json",
        )
    finally:
        temp_path.unlink(missing_ok=True)


def record_session(raw_input: str, cli: str | None, pending_dir: Path, now_ms: int | None = None) -> dict[str, Any]:
    hook = parse_hook_input(raw_input)
    source = build_source(hook, now_ms=now_ms)
    return record_source(source, cli, pending_dir, now_ms=now_ms)


def record_codex_session(raw_input: str, cli: str | None, pending_dir: Path, now_ms: int | None = None) -> dict[str, Any]:
    hook = parse_codex_hook_input(raw_input)
    source = build_codex_source(hook, now_ms=now_ms)
    return record_source(source, cli, pending_dir, now_ms=now_ms)


def record_source(source: SourcePayload, cli: str | None, pending_dir: Path, now_ms: int | None = None) -> dict[str, Any]:
    pending_path = save_pending(pending_dir, source, now_ms=now_ms)
    resolved_cli = resolve_cli(cli)
    recorded = False
    error = ""
    cleanup_error = ""
    flushed = 0
    failed = 0
    invalid = 0
    if resolved_cli:
        try:
            write_payload(
                resolved_cli,
                {
                    "path": source.path,
                    "content": source.content,
                    "metadata_json": json.dumps(source.metadata, ensure_ascii=False, sort_keys=True),
                },
            )
            recorded = True
        except (OSError, subprocess.CalledProcessError) as cause:
            error = str(cause)[:800]
        if recorded:
            skip_paths: set[Path] = set()
            try:
                pending_path.unlink(missing_ok=True)
            except OSError as cause:
                cleanup_error = str(cause)[:800]
                quarantined = quarantine_pending(pending_path, "recorded")
                if quarantined == pending_path:
                    skip_paths.add(pending_path)
            flush_result = flush_pending_report(resolved_cli, pending_dir, skip_paths=skip_paths)
            flushed = len(flush_result.flushed)
            failed = len(flush_result.failed)
            invalid = len(flush_result.invalid)
    else:
        error = "kinic-vfs-cli not found"
    return {
        "recorded": recorded,
        "pending_path": str(pending_path),
        "source_path": source.path,
        "flushed_pending": flushed,
        "failed_pending": failed,
        "invalid_pending": invalid,
        "error": error,
        "cleanup_error": cleanup_error,
    }


def default_pending_dir() -> Path:
    explicit = os.environ.get("CLAUDE_PLUGIN_DATA")
    if explicit:
        return Path(explicit) / "pending-sessions"
    return Path.home() / ".claude" / "kinic-skill-recorder" / "pending-sessions"


def default_codex_pending_dir() -> Path:
    explicit = os.environ.get("CODEX_PLUGIN_DATA") or os.environ.get("KINIC_CODEX_PLUGIN_DATA")
    if explicit:
        return Path(explicit) / "pending-sessions"
    return Path.home() / ".codex" / "kinic-skill-recorder" / "pending-sessions"


def safe_source_stem(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).replace("..", "-")
    normalized = re.sub(r"-{2,}", "-", normalized).strip("-._")
    if not normalized:
        normalized = "session"
    if not normalized[0].isalnum():
        normalized = f"session-{normalized}"
    if len(normalized) <= 128:
        return normalized
    return normalized[:119].rstrip("-._") + f"-{hash_text(normalized)}"


def source_id_for_session(session_id: str, transcript_path: Path, captured_at: str) -> str:
    source_key = "\n".join([session_id, str(transcript_path), captured_at])
    source_hash = hashlib.sha256(source_key.encode("utf-8")).hexdigest()[:16]
    return f"session-{source_hash}"


def hash_text(value: str) -> str:
    hash_value = 2166136261
    for char in value:
        hash_value ^= ord(char)
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    return f"{hash_value:08x}"


def rfc3339_now(now_ms: int | None = None) -> str:
    millis = now_ms if now_ms is not None else int(time.time() * 1000)
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(millis / 1000)) + f".{millis % 1000:03d}Z"


def main() -> int:
    parser = argparse.ArgumentParser(prog="kinic-agent-runtime-session")
    subcommands = parser.add_subparsers(dest="command", required=True)
    record = subcommands.add_parser("record-claude-session")
    record.add_argument("--cli")
    record.add_argument("--pending-dir")
    record_codex = subcommands.add_parser("record-codex-session")
    record_codex.add_argument("--cli")
    record_codex.add_argument("--pending-dir")
    args = parser.parse_args()
    if args.command == "record-claude-session":
        pending_dir = Path(args.pending_dir) if args.pending_dir else default_pending_dir()
        try:
            result = record_session(sys.stdin.read(), args.cli, pending_dir)
            print(json.dumps(result, indent=2))
        except Exception as cause:
            print(f"kinic session capture skipped: {cause}", file=sys.stderr)
        return 0
    if args.command == "record-codex-session":
        pending_dir = Path(args.pending_dir) if args.pending_dir else default_codex_pending_dir()
        try:
            result = record_codex_session(sys.stdin.read(), args.cli, pending_dir)
            print(json.dumps(result, indent=2))
        except Exception as cause:
            print(f"kinic codex session capture skipped: {cause}", file=sys.stderr)
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
