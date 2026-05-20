"""Where: plugins/runtime/kinic_agent_runtime/cli.py
What: Shared kinic-vfs-cli subprocess helpers.
Why: Runtime adapters must apply identity and binary resolution rules consistently.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
REPO_DEBUG_CLI = REPO_ROOT / "target" / "debug" / "kinic-vfs-cli"


def resolve_cli(cli: str | None = None) -> str | None:
    candidate = cli or os.environ.get("KINIC_VFS_CLI")
    if candidate:
        return candidate if Path(candidate).exists() or shutil.which(candidate) else None
    path_cli = shutil.which("kinic-vfs-cli")
    if path_cli:
        return path_cli
    if REPO_DEBUG_CLI.is_file():
        return str(REPO_DEBUG_CLI)
    return None


def cli_command(cli: str, *args: str) -> list[str]:
    command = [cli]
    if os.environ.get("KINIC_VFS_CLI_ALLOW_NON_II") == "1":
        command.append("--allow-non-ii-identity")
    command.extend(args)
    return command


def run_cli(cli: str, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cli_command(cli, *args),
        check=check,
        text=True,
        capture_output=True,
    )


def resolve_runner() -> list[str] | None:
    candidate = os.environ.get("KINIC_SKILL_EVOLVE")
    if candidate:
        return [candidate] if Path(candidate).exists() or shutil.which(candidate) else None
    runner = shutil.which("kinic-skill-evolve")
    if runner:
        return [runner]
    return None
