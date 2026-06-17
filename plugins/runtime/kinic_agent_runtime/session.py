"""Where: plugins/runtime/kinic_agent_runtime/session.py
What: Persist Claude Code session transcripts as Kinic raw source nodes.
Why: Agent conversations should be retained as source evidence without blocking session exit.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .cli import resolve_cli, run_cli


PROVIDER = "claude-code"
SOURCE_PROVIDER = "claudecode"
MAX_SOURCE_CHARS = 300_000
REDACTED = "[REDACTED]"
SECRET_KEY_NAMES = {"apikey", "token", "secret", "password", "cookie", "authorization"}
SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}"),
    re.compile(
        r'(?i)(?P<prefix>"(?:api[_-]?key|token|secret|password|cookie|authorization)"\s*:\s*")'
        r'(?P<secret>(?:\\.|[^"\\])*)'
        r'(?P<suffix>")'
    ),
    re.compile(r"(?i)\b(api[_-]?key|token|secret|password|cookie)\b(\s*[:=]\s*)([^\s'\"`]+)"),
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


def parse_hook_input(raw: str) -> HookInput:
    data = json.loads(raw)
    session_id = required_text(data, "session_id")
    transcript_path = Path(required_text(data, "transcript_path"))
    cwd = text_value(data.get("cwd"))
    reason = text_value(data.get("reason"))
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


def build_source(hook: HookInput, now_ms: int | None = None, max_chars: int = MAX_SOURCE_CHARS) -> SourcePayload:
    captured_at = rfc3339_now(now_ms)
    entries, structured_redacted = parse_transcript(hook.transcript_path)
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
    limited, truncated = limit_text(redacted_transcript, max_chars)
    source_id = safe_source_stem(session_id)
    metadata = {
        "provider": PROVIDER,
        "session_id": session_id,
        "cwd": cwd,
        "ended_reason": reason,
        "captured_at": captured_at,
        "transcript_path": transcript_path,
        "message_count": len(entries),
        "redacted": redacted,
        "truncated": truncated,
        "original_chars": len(redacted_transcript),
        "saved_chars": len(limited),
    }
    lines = [
        "# Raw Claude Code Session",
        "",
        "## Metadata",
        "",
        f"- provider: {json.dumps(PROVIDER)}",
        f"- session_id: {json.dumps(session_id)}",
        f"- cwd: {json.dumps(cwd)}",
        f"- ended_reason: {json.dumps(reason)}",
        f"- captured_at: {json.dumps(captured_at)}",
        f"- transcript_path: {json.dumps(transcript_path)}",
        f"- message_count: {len(entries)}",
        f"- redacted: {str(redacted).lower()}",
        f"- truncated: {str(truncated).lower()}",
        f"- original_chars: {len(redacted_transcript)}",
        f"- saved_chars: {len(limited)}",
        "",
        "## Transcript",
        "",
        limited,
    ]
    return SourcePayload(
        path=f"/Sources/raw/{SOURCE_PROVIDER}/{source_id}.md",
        content="\n".join(lines).rstrip() + "\n",
        metadata=metadata,
    )


def parse_transcript(path: Path) -> tuple[list[tuple[str, str]], bool]:
    entries: list[tuple[str, str]] = []
    redacted = False
    for line in path.read_text(errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        role = role_from_entry(data)
        content = content_from_entry(data)
        if role and content.text:
            entries.append((role, content.text))
            redacted = redacted or content.redacted
    return entries, redacted


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


def content_from_entry(data: Any) -> RenderedText:
    if not isinstance(data, dict):
        return RenderedText("")
    if isinstance(data.get("message"), dict):
        return content_text(data["message"].get("content"))
    return content_text(data.get("content"))


def content_text(value: Any) -> RenderedText:
    if isinstance(value, str):
        return RenderedText(value.strip())
    if isinstance(value, list):
        parts = [content_part_text(part) for part in value]
        text = "\n".join(part.text for part in parts if part.text).strip()
        return RenderedText(text, any(part.redacted for part in parts))
    if isinstance(value, dict):
        part = content_part_text(value)
        return RenderedText(part.text.strip(), part.redacted)
    return RenderedText("")


def content_part_text(part: Any) -> RenderedText:
    if isinstance(part, str):
        return RenderedText(part.strip())
    if not isinstance(part, dict):
        return RenderedText("")
    part_type = part.get("type")
    if part_type == "text" and isinstance(part.get("text"), str):
        return RenderedText(part["text"].strip())
    if part_type == "tool_use":
        name = text_value(part.get("name")) or "tool"
        redacted_input, input_redacted = redact_value(part.get("input", {}))
        tool_input = json.dumps(redacted_input, ensure_ascii=False, sort_keys=True)
        return RenderedText(f"[tool_use: {name}]\n{tool_input}", input_redacted)
    if part_type == "tool_result":
        tool_content = content_text(part.get("content"))
        return RenderedText(f"[tool_result]\n{tool_content.text}".strip(), tool_content.redacted)
    if isinstance(part.get("text"), str):
        return RenderedText(part["text"].strip())
    if isinstance(part.get("content"), (str, list, dict)):
        return content_text(part.get("content"))
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
    return normalized in SECRET_KEY_NAMES


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
    return value[:max_chars].rstrip() + "\n\n[truncated]\n", True


def save_pending(pending_dir: Path, source: SourcePayload, now_ms: int | None = None) -> Path:
    pending_dir.mkdir(parents=True, exist_ok=True)
    millis = now_ms if now_ms is not None else int(time.time() * 1000)
    stem = safe_source_stem(str(source.metadata.get("session_id", "session")))
    path = pending_dir / f"{millis}-{stem}.json"
    payload = {
        "schema_version": 1,
        "kind": "claude_code_session_source",
        "path": source.path,
        "content": source.content,
        "metadata_json": json.dumps(source.metadata, ensure_ascii=False, sort_keys=True),
        "saved_locally_at": millis,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    return path


def flush_pending(cli: str, pending_dir: Path) -> list[Path]:
    flushed: list[Path] = []
    if not pending_dir.is_dir():
        return flushed
    for path in sorted(pending_dir.glob("*.json")):
        payload = json.loads(path.read_text())
        write_payload(cli, payload)
        path.unlink()
        flushed.append(path)
    return flushed


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
    resolved_cli = resolve_cli(cli)
    flushed = 0
    if resolved_cli:
        try:
            flushed = len(flush_pending(resolved_cli, pending_dir))
        except (OSError, json.JSONDecodeError, subprocess.CalledProcessError):
            flushed = 0
    hook = parse_hook_input(raw_input)
    source = build_source(hook, now_ms=now_ms)
    pending_path = save_pending(pending_dir, source, now_ms=now_ms)
    recorded = False
    error = ""
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
            pending_path.unlink(missing_ok=True)
            recorded = True
        except (OSError, subprocess.CalledProcessError) as cause:
            error = str(cause)[:800]
    else:
        error = "kinic-vfs-cli not found"
    return {
        "recorded": recorded,
        "pending_path": str(pending_path),
        "source_path": source.path,
        "flushed_pending": flushed,
        "error": error,
    }


def default_pending_dir() -> Path:
    explicit = os.environ.get("CLAUDE_PLUGIN_DATA")
    if explicit:
        return Path(explicit) / "pending-sessions"
    return Path.home() / ".claude" / "kinic-skill-recorder" / "pending-sessions"


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
    args = parser.parse_args()
    if args.command == "record-claude-session":
        pending_dir = Path(args.pending_dir) if args.pending_dir else default_pending_dir()
        try:
            result = record_session(sys.stdin.read(), args.cli, pending_dir)
            print(json.dumps(result, indent=2))
        except Exception as cause:
            print(f"kinic session capture skipped: {cause}", file=sys.stderr)
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
