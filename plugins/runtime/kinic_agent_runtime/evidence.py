"""Where: plugins/runtime/kinic_agent_runtime/evidence.py
What: Shared Skill Registry run evidence recording helpers.
Why: Hermes and Codex should record evidence through the same CLI path.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from .cli import resolve_cli, run_cli


PLUGIN_VERSION = "0.1.2"


def with_recorded_by(evidence: dict[str, Any], recorded_by: str | None) -> dict[str, Any]:
    payload = dict(evidence)
    if recorded_by:
        payload["recorded_by"] = recorded_by
    return payload


def record_run(cli: str, skill_id: str, evidence: dict[str, Any], recorded_by: str | None = None) -> tuple[bool, str | None]:
    payload = with_recorded_by(evidence, recorded_by)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(payload, handle, indent=2)
        temp_path = Path(handle.name)
    try:
        run_cli(
            cli,
            "skill",
            "record-run",
            skill_id,
            "--evidence-json",
            str(temp_path),
        )
        return True, None
    except subprocess.CalledProcessError as error:
        return False, str(error.stderr or error)
    finally:
        temp_path.unlink(missing_ok=True)


def record_run_file(cli: str, skill_id: str, evidence_json: Path, recorded_by: str | None = None) -> str:
    if recorded_by:
        evidence = json.loads(evidence_json.read_text())
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(with_recorded_by(evidence, recorded_by), handle, indent=2)
            temp_path = Path(handle.name)
    else:
        temp_path = evidence_json
    try:
        result = run_cli(
            cli,
            "skill",
            "record-run",
            skill_id,
            "--evidence-json",
            str(temp_path),
            "--json",
        )
        return result.stdout
    finally:
        if temp_path != evidence_json:
            temp_path.unlink(missing_ok=True)


def save_pending(
    pending_dir: Path,
    skill_id: str,
    evidence: dict[str, Any],
    recording_error: str,
) -> Path:
    pending_dir.mkdir(parents=True, exist_ok=True)
    safe_skill = "".join(ch for ch in skill_id if ch.isalnum() or ch in "-_.") or "unknown"
    path = pending_dir / f"{int(time.time() * 1000)}-{safe_skill}.json"
    payload = dict(evidence)
    payload.setdefault("schema_version", 1)
    payload.setdefault("skill_id", skill_id)
    payload["recording_error"] = recording_error[:800]
    payload["recorded_locally_at"] = int(time.time() * 1000)
    payload["plugin_version"] = PLUGIN_VERSION
    path.write_text(json.dumps(payload, indent=2))
    return path


def main() -> int:
    parser = argparse.ArgumentParser(prog="kinic-agent-runtime-evidence")
    subcommands = parser.add_subparsers(dest="command", required=True)

    record = subcommands.add_parser("record-run")
    record.add_argument("skill_id")
    record.add_argument("evidence_json_file")
    record.add_argument("--cli")
    record.add_argument("--recorded-by")

    args = parser.parse_args()
    if args.command == "record-run":
        return record_run_command(args)
    return 1


def record_run_command(args: argparse.Namespace) -> int:
    if not args.skill_id:
        print("error: skill id is required", file=sys.stderr)
        return 64
    evidence_json = Path(args.evidence_json_file)
    if not evidence_json.is_file():
        print(f"error: evidence JSON file not found: {evidence_json}", file=sys.stderr)
        return 66
    cli = resolve_cli(args.cli)
    if not cli:
        print("error: kinic-vfs-cli not found; set KINIC_VFS_CLI or install kinic-vfs-cli in PATH", file=sys.stderr)
        return 69
    try:
        print(record_run_file(cli, args.skill_id, evidence_json, args.recorded_by), end="")
        return 0
    except subprocess.CalledProcessError as error:
        print(error.stderr or str(error), file=sys.stderr)
        return error.returncode or 3


if __name__ == "__main__":
    raise SystemExit(main())
