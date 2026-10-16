"""Thin Codex transport; the CLI owns project routing, evidence, and learning jobs."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from .cli import cli_command, resolve_cli

MAX_INPUT_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024
CLI_TIMEOUT_SECONDS = 2


def handle(data: dict) -> dict:
    event = data.get("hook_event_name")
    if event not in {"UserPromptSubmit", "PostToolUse", "Stop"}:
        raise ValueError("unsupported hook event")
    cwd = Path(data.get("cwd") or os.getcwd()).resolve()
    # Forward source paths and original evidence to the CLI only. It handles
    # redaction, persisted transcript parsing, session binding, and completeness.
    request = {**data, "event": event, "engine": "codex", "cwd": str(cwd)}
    if event == "UserPromptSubmit":
        request["task"] = data.get("prompt", "")
    if event == "Stop":
        request["terminal"] = True
    cli = resolve_cli()
    if not cli:
        raise ValueError("CLI unavailable")
    command = cli_command(cli, "agent", "hook", "--engine", "codex", "--cwd", str(cwd))
    configured = os.environ.get("KINIC_LEARNING_RECALL_CONFIG")
    if configured:
        command.extend(["--recall-config", configured])
    # Disk-backed capture avoids unbounded RAM if a faulty CLI floods stdout;
    # subprocess.run kills and reaps the child on timeout. CLI diagnostics are
    # deliberately not echoed because they may contain transcript excerpts.
    with tempfile.TemporaryFile() as output:
        subprocess.run(command, input=json.dumps(request, ensure_ascii=False).encode(),
                       cwd=cwd, stdout=output, stderr=subprocess.DEVNULL,
                       timeout=CLI_TIMEOUT_SECONDS, check=True)
        output.seek(0)
        raw = output.read(MAX_OUTPUT_BYTES + 1)
    if len(raw) > MAX_OUTPUT_BYTES:
        raise ValueError("CLI output limit exceeded")
    reply = json.loads(raw)
    if not isinstance(reply, dict):
        raise ValueError("CLI reply must be an object")
    if reply.get("skipped") is True:
        return {}
    if event == "UserPromptSubmit":
        context = reply.get("additionalContext")
        specific = reply.get("hookSpecificOutput")
        if not isinstance(context, str) and isinstance(specific, dict):
            context = specific.get("additionalContext")
        if not isinstance(context, str):
            raise ValueError("CLI recall reply has no context")
        if context:
            return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": context}}
    elif reply.get("recorded") is not True:
        raise ValueError("CLI did not acknowledge evidence")
    return {}


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError("hook input exceeds limit")
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("hook input must be an object")
        output = handle(data)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        print("Kinic Wiki: hook not acknowledged by CLI; evidence may be incomplete", file=sys.stderr)
        output = {}
    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
